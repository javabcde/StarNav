// 站点核心（site core）：sites 表的基础共享原语——规范行投影（SITE_SELECT_COLUMNS）、
// 可见性谓词应用（applyVisibilityWhere）、载荷规范化、去重键、重复点查、排序前置、全量读取。
// 2026-08-16 架构评审候选 1：从 siteService 拆出的中立层。submission/transfer 改从本模块导入，
// 解除 siteService ↔ {submission, transfer} 的 re-export 双向环；siteService 保留同名
// re-export 垫片保持存量测试与调用方 import 面不变（同 ADR-0003 模式）。本模块不反向
// import siteService/submissionService/transferService——它是站点域的叶层。
import { cleanText, normalizeSortOrder, nullableText } from '../lib/utils.js';
import { normalizeVisibility, visibilityWhere } from './accessService.js';
import { PRIVATE_BOOKMARK_CATEGORY } from './privateBookmarkService.js';
import { resolveSpaceId } from './spaceService.js';
import { attachTagsToSites, normalizeTags } from './tagService.js';

// 站点行规范投影：sites 主查询统一列集（含分类名兜底 catelog）。
export const SITE_SELECT_COLUMNS = `
  s.id,
  s.name,
  s.url,
  s.logo,
  s.desc,
  COALESCE(c.name, s.catelog) AS catelog,
  s.category_id,
  s.space_id,
  s.visibility,
  s.sort_order,
  s.hits,
  s.last_visit_time,
  s.last_checked_at,
  s.last_status_code,
  s.last_error,
  s.sync_source,
  s.browser_bookmark_id,
  s.create_time,
  s.update_time
`;

// 可见性过滤唯一入口：把 visibilityWhere 渲染的谓词 push 进查询的 where/binds。
// 各查询只传自己的访问上下文（resolvedAccess / access），谓词与绑定顺序由 accessService 单一持有。
export function applyVisibilityWhere(where, binds, access) {
  const { sql, binds: visibilityBinds } = visibilityWhere(access);
  if (sql) {
    where.push(sql);
    binds.push(...visibilityBinds);
  }
}

// URL 规范化去重键：去 www / 尾斜杠 / 大小写，保留 query，http/https 同键（CONTEXT.md「去重键」）。
export function normalizeDuplicateUrlKey(value) {
  const raw = cleanText(value);
  if (!raw) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    const path = parsed.pathname.replace(/\/+$/g, '') || '/';
    const search = parsed.search;
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/g, '').toLowerCase();
  }
}

// 站点载荷规范化：文本 cleanText、图标/描述可空、排序归一、可见性回退、标签归一。
// 必填缺失（name/url/catelog）抛错——创建与投稿共用同一校验面。
export function normalizeSitePayload(config) {
  const name = cleanText(config?.name);
  const url = cleanText(config?.url);
  const catelog = cleanText(config?.catelog || config?.category || config?.category_name);
  const logo = nullableText(config?.logo);
  const desc = nullableText(config?.desc || config?.description);
  const sort_order = normalizeSortOrder(config?.sort_order);
  const visibility = normalizeVisibility(config?.visibility, catelog);
  const tags = normalizeTags(config?.tags || config?.tag_names);
  const space = cleanText(config?.space || config?.space_slug);
  const space_id = config?.space_id === undefined || config?.space_id === null || config?.space_id === ''
    ? null
    : Number(config.space_id);

  if (!name || !url || !catelog) {
    throw new Error('Name, URL and Catelog are required');
  }

  return { name, url, logo, desc, catelog, visibility, sort_order, tags, space, space_id: Number.isFinite(space_id) && space_id > 0 ? space_id : null };
}

// 重复 URL 错误构造：code=DUPLICATE_URL（→ 409），scope 区分 create/update/submit 等来源。
export function buildDuplicateError(duplicate, scope = 'site') {
  const summary = duplicate?.name ? `${duplicate.name}（${duplicate.url}）` : duplicate?.url || '';
  const error = new Error(`Duplicate URL: 已存在书签 #${duplicate?.id} ${summary}`);
  error.code = 'DUPLICATE_URL';
  error.scope = scope;
  error.duplicate = duplicate;
  return error;
}

// 新站点前置排序号：取当前最小 sort_order 再减 10（下限 int32），无数据时 9999。
export async function getPrependSortOrder(env, spaceId = null) {
  const normalizedSpaceId = Number(spaceId);
  if (Number.isFinite(normalizedSpaceId) && normalizedSpaceId > 0) {
    const row = await env.NAV_DB.prepare('SELECT MIN(sort_order) AS min_sort_order FROM sites WHERE space_id = ?').bind(normalizedSpaceId).first();
    const minSortOrder = Number(row?.min_sort_order);
    if (!Number.isFinite(minSortOrder)) return 9999;
    return Math.max(-2147483648, Math.round(minSortOrder) - 10);
  }

  const row = await env.NAV_DB.prepare('SELECT MIN(sort_order) AS min_sort_order FROM sites').first();
  const minSortOrder = Number(row?.min_sort_order);
  if (!Number.isFinite(minSortOrder)) return 9999;
  return Math.max(-2147483648, Math.round(minSortOrder) - 10);
}

// 按去重键点查重复站点（url_key 索引，避免全表扫描）。
export async function findDuplicateSite(env, url, { excludeId = null } = {}) {
  const key = normalizeDuplicateUrlKey(url);
  if (!key) return null;
  // 通过 url_key 索引点查，避免全表扫描 + 全量 JS 规范化（依赖迁移已回填 url_key）。
  const row = excludeId
    ? await env.NAV_DB.prepare('SELECT id, name, url, catelog FROM sites WHERE url_key = ? AND id <> ? LIMIT 1').bind(key, Number(excludeId)).first()
    : await env.NAV_DB.prepare('SELECT id, name, url, catelog FROM sites WHERE url_key = ? LIMIT 1').bind(key).first();
  return row ? { id: row.id, name: row.name, url: row.url, catelog: row.catelog } : null;
}

// 全量读取（首页渲染与全量导出共用）：空间过滤 + 访问上下文可见性过滤（access 缺省不过滤，
// 仅测试路径——home/exportConfig 两个生产调用面均显式传 access，见 docs/adr/0003）。
export async function getAllSites(env, { space = '', space_id = null, access = null } = {}) {
  const hasSpaceFilter = Boolean(space_id || cleanText(space));
  const resolvedSpaceId = hasSpaceFilter ? (space_id ? Number(space_id) : await resolveSpaceId(env, space)) : null;
  const where = [];
  const binds = [];

  if (Number.isFinite(resolvedSpaceId) && resolvedSpaceId > 0) {
    if (cleanText(space) === 'default') {
      where.push('(s.space_id = ? OR s.space_id IS NULL)');
    } else {
      where.push('s.space_id = ?');
    }
    binds.push(resolvedSpaceId);
  }

  if (access && !access.adminAuthed) {
    applyVisibilityWhere(where, binds, access);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      ${whereSql}
      ORDER BY s.sort_order ASC, datetime(s.create_time) DESC, s.id DESC
    `).bind(...binds).all();

    try {
      return await attachTagsToSites(env, results || []);
    } catch (tagError) {
      console.warn(`[sites] attach tags skipped for all-sites: ${tagError?.message || tagError}`);
      return (results || []).map((site) => ({ ...site, tags: [] }));
    }
  } catch (error) {
    console.warn(`[sites] all-sites primary fallback: ${error?.message || error}`);
  }

  try {
    const fallbackWhere = [];
    const fallbackBinds = [];
    // 降级查询无 categories 连接：匿名/未解锁时仅挡私密分类（与 getSites fallback 同语义）
    if (access && !access.adminAuthed && !access.privateUnlocked) {
      fallbackWhere.push('s.catelog <> ?');
      fallbackBinds.push(PRIVATE_BOOKMARK_CATEGORY);
    }
    const fallbackWhereSql = fallbackWhere.length ? `WHERE ${fallbackWhere.join(' AND ')}` : '';
    const { results } = await env.NAV_DB.prepare(`
      SELECT
        s.id,
        s.name,
        s.url,
        s.logo,
        s.desc,
        s.catelog,
        NULL AS category_id,
        NULL AS space_id,
        'public' AS visibility,
        9999 AS sort_order,
        0 AS hits,
        NULL AS last_visit_time,
        NULL AS last_checked_at,
        NULL AS last_status_code,
        NULL AS last_error,
        s.sync_source,
        s.browser_bookmark_id,
        s.create_time,
        s.create_time AS update_time
      FROM sites s
      ${fallbackWhereSql}
      ORDER BY datetime(s.create_time) DESC, s.id DESC
    `).bind(...fallbackBinds).all();

    return (results || []).map((site) => ({ ...site, tags: [] }));
  } catch (fallbackError) {
    console.warn(`[sites] all-sites legacy fallback failed: ${fallbackError?.message || fallbackError}`);
    return [];
  }
}
