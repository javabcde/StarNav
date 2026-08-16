// 站点域核心（sites 表）：CRUD、列表/读取查询、搜索评分、站点/搜索分析、健康检测与预览抓取。
// 六领域门面拆分（2026-08-16 架构评审候选 5）：
// - 健康谓词（dead/ok/unknown）单一渲染源在 healthQuery.js，本文件 getSites/searchSites 与
//   systemHealthService 的 count 查询统一改调，不再各自手写 SQL 副本；
// - 投稿审核簇（pending_sites 表）在 submissionService.js，导入/导出簇在 transferService.js，
//   本文件保留同名 re-export 垫片（存量测试 import 面不变，同 ADR-0003 模式）；
// - 搜索/评分与 analytics 簇留在本文件：搜索/评分与 CRUD 共享表与过滤解析，接缝不成立——
//   searchSites/getSiteAnalytics 与列表查询共享私有查询基建（SITE_SELECT_COLUMNS、applyVisibilityWhere、
//   toSafeLikePattern、attachTagsToSites 及同构的 legacy 降级查询形态），整簇搬迁必须导出这套私有基建
//   （形成双向深循环的假拆分）或复制共享逻辑，均违反纯搬迁约束；recordSearchTerm 与 searchSites 同属
//   /api/search 端点链路、getSearchAnalytics 与 getSiteAnalytics 同属 analytics 读簇，随簇整体保留。
import { cleanText, normalizeIdList, normalizeSortOrder, nullableText } from '../lib/utils.js';
import { PRIVATE_BOOKMARK_CATEGORY } from './privateBookmarkService.js';
import { getDescendantCategoryNames, upsertCategoryByName } from './categoryService.js';
import { attachTagsToSites, normalizeTags, setSiteTags } from './tagService.js';
import { faviconFailedKey } from './iconService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';
import { deadSiteSql, isDeadSite, okSiteSql, unknownSiteSql } from './healthQuery.js';
import { canAccessSite, canListSite, isPrivateSite, normalizeVisibility, SITE_VISIBILITIES, visibilityWhere } from './accessService.js';
// 可见性规则已迁入 accessService（docs/adr/0003）；re-export 保持存量测试 import 面。
export { canAccessSite, canListSite, isPrivateSite, normalizeVisibility, SITE_VISIBILITIES, visibilityWhere } from './accessService.js';
// 投稿审核簇（pending_sites 表）已迁入 submissionService（2026-08-16 架构评审候选 5，纯搬迁）；
// re-export 垫片保持存量测试与调用方 import 面不变，同 ADR-0003 模式。
export { submitSite, getPendingSites, getSubmissionAnalytics, approvePendingSite, rejectPendingSite } from './submissionService.js';
// 导入/导出簇已迁入 transferService（backupService 已改为直连）；re-export 垫片保持存量测试与调用方 import 面不变。
export { normalizeImportPayload, previewImportSites, importSites, exportConfig } from './transferService.js';

// 可见性过滤唯一入口：把 visibilityWhere 渲染的谓词 push 进查询的 where/binds。
// 各查询只传自己的访问上下文（resolvedAccess / access），谓词与绑定顺序由 accessService 单一持有。
function applyVisibilityWhere(where, binds, access) {
  const { sql, binds: visibilityBinds } = visibilityWhere(access);
  if (sql) {
    where.push(sql);
    binds.push(...visibilityBinds);
  }
}

/**
 * @typedef {'public' | 'private' | 'unlisted' | 'admin_only'} SiteVisibility
 */

/**
 * @typedef {object} SiteRecord
 * @property {number|string} [id]
 * @property {string} [name]
 * @property {string} [url]
 * @property {string|null} [logo]
 * @property {string|null} [desc]
 * @property {string} [catelog]
 * @property {number|string|null} [category_id]
 * @property {SiteVisibility|string|null} [visibility]
 * @property {number|string|null} [sort_order]
 * @property {number|string|null} [hits]
 * @property {string|null} [last_visit_time]
 * @property {string|null} [last_checked_at]
 * @property {number|string|null} [last_status_code]
 * @property {string|null} [last_error]
 * @property {string|null} [create_time]
 * @property {string|null} [update_time]
 * @property {string[]} [tags]
 */


/**
 * @typedef {object} SitePayload
 * @property {string} [name]
 * @property {string} [url]
 * @property {string|null} [logo]
 * @property {string|null} [desc]
 * @property {string|null} [description]
 * @property {string} [catelog]
 * @property {string} [category]
 * @property {string} [category_name]
 * @property {SiteVisibility|string} [visibility]
 * @property {number|string|null} [sort_order]
 * @property {string[]|string} [tags]
 * @property {string[]|string} [tag_names]
 */


function toSafeLikePattern(value, maxLength = 48) {
  const text = cleanText(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
  if (!text) return '';
  return `%${text.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
}

const CJK_INITIALS = {
  星: 'x', 空: 'k', 图: 't', 床: 'c', 云: 'y', 盘: 'p', 网: 'w', 资: 'z', 源: 'y', 工: 'g', 具: 'j',
  开: 'k', 发: 'f', 设: 's', 计: 'j', 素: 's', 材: 'c', 代: 'd', 码: 'm', 托: 't', 管: 'g',
  服: 'f', 务: 'w', 器: 'q', 运: 'y', 维: 'w', 博: 'b', 客: 'k', 搜: 's', 索: 's', 导: 'd',
  航: 'h', 书: 's', 签: 'q', 分: 'f', 类: 'l', 标: 'b', 私: 's', 人: 'r', 常: 'c',
  用: 'y', 站: 'z', 点: 'd', 链: 'l', 接: 'j', 文: 'w', 档: 'd', 影: 'y', 音: 'y', 视: 's',
  频: 'p', 下: 'x', 载: 'z', 上: 's', 传: 'c', 压: 'y', 缩: 's', 转: 'z', 换: 'h', 编: 'b',
  辑: 'j', 生: 's', 成: 'c', 智: 'z', 能: 'n', 大: 'd', 模: 'm', 型: 'x'
};

const PINYIN_INITIAL_BOUNDARIES = [
  ['a', '阿'], ['b', '八'], ['c', '嚓'], ['d', '咑'], ['e', '妸'], ['f', '发'],
  ['g', '旮'], ['h', '哈'], ['j', '击'], ['k', '喀'], ['l', '垃'], ['m', '妈'],
  ['n', '拿'], ['o', '哦'], ['p', '啪'], ['q', '期'], ['r', '然'], ['s', '撒'],
  ['t', '塌'], ['w', '挖'], ['x', '昔'], ['y', '压'], ['z', '匝'],
];

function normalizeSearchText(value) {
  return cleanText(value).toLowerCase();
}

function getHostParts(url) {
  const raw = cleanText(url);
  if (!raw) return [];
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const parsed = new URL(withProtocol);
    return [
      parsed.hostname.toLowerCase(),
      parsed.hostname.replace(/^www\./i, '').toLowerCase(),
      parsed.pathname.toLowerCase(),
    ].filter(Boolean);
  } catch {
    return [raw.toLowerCase()];
  }
}

function inferPinyinInitial(char) {
  if (!/[\u4e00-\u9fff]/.test(char)) return '';
  if (CJK_INITIALS[char]) return CJK_INITIALS[char];

  let initial = '';
  for (const [letter, boundary] of PINYIN_INITIAL_BOUNDARIES) {
    if (char.localeCompare(boundary, 'zh-Hans-CN') >= 0) {
      initial = letter;
    } else {
      break;
    }
  }
  return initial;
}

function getCjkInitials(value) {
  return Array.from(cleanText(value)).map((char) => inferPinyinInitial(char)).join('');
}

function getCjkNgrams(value) {
  const chars = Array.from(cleanText(value).replace(/\s+/g, '')).filter((char) => /[\u4e00-\u9fff]/.test(char));
  const grams = new Set();
  for (const size of [2, 3, 4]) {
    for (let i = 0; i + size <= chars.length; i += 1) {
      grams.add(chars.slice(i, i + size).join(''));
    }
  }
  return [...grams];
}

function parseSearchQuery(keyword) {
  let text = cleanText(keyword);
  const filters = { tags: [], categories: [], urls: [], visibility: '', health: '' };
  text = text.replace(/\b(tag|cat|category|url|is):(?:"([^"]+)"|'([^']+)'|(\S+))/gi, (match, key, quoted, singleQuoted, plain) => {
    const value = cleanText(quoted || singleQuoted || plain);
    const normalizedKey = key.toLowerCase();
    if (!value) return ' ';
    if (normalizedKey === 'tag') filters.tags.push(value);
    else if (normalizedKey === 'cat' || normalizedKey === 'category') filters.categories.push(value);
    else if (normalizedKey === 'url') filters.urls.push(value);
    else if (normalizedKey === 'is') {
      const state = value.toLowerCase();
      if (['private', 'public', 'unlisted', 'admin_only'].includes(state)) filters.visibility = state;
      if (['dead', 'bad', 'error'].includes(state)) filters.health = 'dead';
      if (['ok', 'alive'].includes(state)) filters.health = 'ok';
    }
    return ' ';
  });

  const terms = new Set();
  const phrase = cleanText(text);
  if (phrase) terms.add(phrase);
  phrase.split(/\s+/).map(cleanText).filter(Boolean).forEach((term) => terms.add(term));
  getCjkNgrams(phrase).forEach((term) => terms.add(term));

  return { raw: cleanText(keyword), terms: [...terms].slice(0, 24), filters };
}

function matchesAdvancedFilters(site, filters) {
  const tags = Array.isArray(site.tags) ? site.tags.map(normalizeSearchText) : [];
  const category = normalizeSearchText(site.catelog);
  const url = normalizeSearchText(site.url);
  const hosts = getHostParts(site.url);
  const visibility = normalizeVisibility(site.visibility, site.catelog);
  const isDead = isDeadSite(site);

  if (filters.visibility && visibility !== filters.visibility) return false;
  if (filters.health === 'dead' && !isDead) return false;
  if (filters.health === 'ok' && isDead) return false;
  if (filters.tags.length && !filters.tags.every((tag) => tags.some((item) => item.includes(normalizeSearchText(tag))))) return false;
  if (filters.categories.length && !filters.categories.every((cat) => category.includes(normalizeSearchText(cat)))) return false;
  if (filters.urls.length && !filters.urls.every((part) => {
    const normalized = normalizeSearchText(part);
    return url.includes(normalized) || hosts.some((host) => host.includes(normalized));
  })) return false;

  return true;
}

function scoreSite(site, terms) {
  const name = normalizeSearchText(site.name);
  const url = normalizeSearchText(site.url);
  const desc = normalizeSearchText(site.desc);
  const category = normalizeSearchText(site.catelog);
  const tags = Array.isArray(site.tags) ? site.tags.map(normalizeSearchText) : [];
  const tagInitials = Array.isArray(site.tags) ? site.tags.map(getCjkInitials).filter(Boolean) : [];
  const hosts = getHostParts(site.url);
  const nameInitials = getCjkInitials(site.name);
  const categoryInitials = getCjkInitials(site.catelog);

  let score = 0;
  const matchedFields = new Set();
  const matchReasons = [];

  for (const rawTerm of terms) {
    const term = normalizeSearchText(rawTerm);
    if (!term) continue;

    if (name === term) {
      score += 1000;
      matchedFields.add('name');
      matchReasons.push(`名称完全匹配：${rawTerm}`);
    } else if (name.includes(term)) {
      score += 520;
      matchedFields.add('name');
      matchReasons.push(`名称包含：${rawTerm}`);
    }

    if (nameInitials && nameInitials.includes(term)) {
      score += 420;
      matchedFields.add('name_initials');
      matchReasons.push(`名称首字母匹配：${rawTerm}`);
    }

    if (tags.some((tag) => tag === term)) {
      score += 360;
      matchedFields.add('tags');
      matchReasons.push(`标签完全匹配：${rawTerm}`);
    } else if (tags.some((tag) => tag.includes(term))) {
      score += 280;
      matchedFields.add('tags');
      matchReasons.push(`标签包含：${rawTerm}`);
    }

    if (tagInitials.some((initials) => initials.includes(term))) {
      score += 240;
      matchedFields.add('tag_initials');
      matchReasons.push(`标签首字母匹配：${rawTerm}`);
    }

    if (category === term) {
      score += 300;
      matchedFields.add('category');
      matchReasons.push(`分类完全匹配：${rawTerm}`);
    } else if (category.includes(term)) {
      score += 230;
      matchedFields.add('category');
      matchReasons.push(`分类包含：${rawTerm}`);
    }

    if (categoryInitials && categoryInitials.includes(term)) {
      score += 180;
      matchedFields.add('category_initials');
      matchReasons.push(`分类首字母匹配：${rawTerm}`);
    }

    if (hosts.some((host) => host.includes(term))) {
      score += 220;
      matchedFields.add('url');
      matchReasons.push(`域名匹配：${rawTerm}`);
    } else if (url.includes(term)) {
      score += 160;
      matchedFields.add('url');
      matchReasons.push(`URL 包含：${rawTerm}`);
    }

    if (desc.includes(term)) {
      score += 120;
      matchedFields.add('desc');
      matchReasons.push(`描述包含：${rawTerm}`);
    }
  }

  const hits = Math.min(Number(site.hits) || 0, 1000);
  score += Math.min(80, Math.log10(hits + 1) * 24);

  const updateTime = Date.parse(site.update_time || site.create_time || '');
  if (Number.isFinite(updateTime)) {
    const ageDays = Math.max(0, (Date.now() - updateTime) / 86400000);
    score += Math.max(0, 40 - Math.min(40, ageDays / 14));
  }

  return {
    score: Math.round(score * 100) / 100,
    matchedFields: [...matchedFields],
    matchReasons: [...new Set(matchReasons)].slice(0, 8),
  };
}

const SITE_SELECT_COLUMNS = `
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

function hasExplicitSortOrder(config) {
  return config?.sort_order !== undefined && config?.sort_order !== null && config?.sort_order !== '';
}

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

/**
 * 分页获取站点列表。
 *
 * 支持分类、标签、关键词、排序和健康状态筛选，并根据访问上下文过滤私密 / 隐藏站点。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {object} [options] 查询参数。
 * @param {number|string} [options.page=1] 页码，从 1 开始。
 * @param {number|string} [options.pageSize=10] 每页数量，最大 100。
 * @param {string} [options.catalog=''] 分类名称。
 * @param {string} [options.keyword=''] 关键词。
 * @param {string} [options.tag=''] 标签名称。
 * @param {string} [options.sort=''] 排序方式，`manual` 表示按手动排序。
 * @param {'ok'|'bad'|'unknown'|string} [options.health=''] 健康状态过滤。
 * @param {object} [options.access=null] 访问上下文（docs/adr/0003）；传入时优先于下方三个布尔选项。
 * @param {boolean} [options.includePrivate=true] 是否包含私密站点候选。
 * @param {boolean} [options.adminAuthed=false] 是否管理员访问。
 * @param {boolean} [options.privateUnlocked=options.includePrivate] 是否已解锁私密书签。
 * @returns {Promise<{data: SiteRecord[], total: number, page: number, pageSize: number}>}
 */
export async function getSites(env, { page = 1, pageSize = 10, catalog = '', keyword = '', tag = '', sort = '', health = '', space = '', space_id = null, all = false, includePrivate = true, adminAuthed = false, privateUnlocked = includePrivate, access = null } = {}) {
  const resolvedAccess = access || { adminAuthed, privateUnlocked };
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (safePage - 1) * safePageSize;
  const hasSpaceFilter = Boolean(space_id || cleanText(space));
  const resolvedSpaceId = hasSpaceFilter ? (space_id ? Number(space_id) : await resolveSpaceId(env, space)) : null;
  const orderSql = sort === 'manual'
    ? 'ORDER BY s.sort_order ASC, datetime(s.create_time) DESC, s.id DESC'
    : sort === 'hits'
      ? 'ORDER BY COALESCE(s.hits, 0) DESC, datetime(s.create_time) DESC, s.id DESC'
      : sort === 'last_visit'
        ? 'ORDER BY COALESCE(datetime(s.last_visit_time), datetime(s.create_time)) DESC, s.id DESC'
        : sort === 'name'
          ? 'ORDER BY s.name ASC, s.id DESC'
          : 'ORDER BY datetime(s.create_time) DESC, s.id DESC';

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

  if (tag) {
    // 用 EXISTS 子查询替代“先查 id 列表再 IN(...)”，避免热门标签下 IN 参数过多触及 D1 变量上限，
    // 同时利用 idx_site_tags_tag 索引。标签不存在时该条件恒为假，自然返回空结果。
    where.push('EXISTS (SELECT 1 FROM site_tags st JOIN tags t ON t.id = st.tag_id WHERE st.site_id = s.id AND t.name = ?)');
    binds.push(cleanText(tag));
  }

  if (catalog) {
    // 父分类包含其全部子孙分类的书签（分类子孙闭包单一源：categoryService，
    // 与首页渲染的树递归同模块相邻，见 getDescendantCategoryNames）；
    const catalogNames = await getDescendantCategoryNames(env, catalog);
    where.push(`(c.name IN (${catalogNames.map(() => '?').join(',')}) OR (s.category_id IS NULL AND s.catelog IN (${catalogNames.map(() => '?').join(',')})))`);
    binds.push(...catalogNames, ...catalogNames);
  }

  const likeKeyword = toSafeLikePattern(keyword);
  if (likeKeyword) {
    where.push("(s.name LIKE ? ESCAPE '\\' OR s.url LIKE ? ESCAPE '\\' OR COALESCE(c.name, s.catelog) LIKE ? ESCAPE '\\')");
    binds.push(likeKeyword, likeKeyword, likeKeyword);
  }

  const healthFilter = cleanText(health).toLowerCase();
  if (healthFilter === 'bad') {
    where.push(deadSiteSql('s'));
  } else if (healthFilter === 'ok') {
    where.push(okSiteSql('s'));
  } else if (healthFilter === 'unknown') {
    where.push(unknownSiteSql('s'));
  }
  if (!resolvedAccess.adminAuthed) {
    applyVisibilityWhere(where, binds, resolvedAccess);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const fromSql = 'FROM sites s LEFT JOIN categories c ON c.id = s.category_id';
  const selectSql = `SELECT ${SITE_SELECT_COLUMNS}`;
  const limitSql = all ? '' : 'LIMIT ? OFFSET ?';
  const limitBinds = all ? [] : [safePageSize, offset];
  try {
    const { results } = await env.NAV_DB.prepare(`
      ${selectSql}
      ${fromSql}
      ${whereSql}
      ${orderSql}
      ${limitSql}
    `).bind(...binds, ...limitBinds).all();

    const countResult = await env.NAV_DB.prepare(`
      SELECT COUNT(*) AS total
      ${fromSql}
      ${whereSql}
    `).bind(...binds).first();

    return {
      data: await attachTagsToSites(env, results || []),
      total: countResult?.total || 0,
      page: safePage,
      pageSize: safePageSize,
    };
  } catch (error) {
    console.warn(`[sites] primary list fallback: ${error?.message || error}`);
  }

  const fallbackWhere = [];
  const fallbackBinds = [];

  if (catalog) {
    fallbackWhere.push(`s.catelog IN (${catalogNames.map(() => '?').join(',')})`);
    fallbackBinds.push(...catalogNames);
  }

  const fallbackLikeKeyword = toSafeLikePattern(keyword);
  if (fallbackLikeKeyword) {
    fallbackWhere.push("(s.name LIKE ? ESCAPE '\\' OR s.url LIKE ? ESCAPE '\\' OR s.catelog LIKE ? ESCAPE '\\')");
    fallbackBinds.push(fallbackLikeKeyword, fallbackLikeKeyword, fallbackLikeKeyword);
  }

  if (!resolvedAccess.adminAuthed && !resolvedAccess.privateUnlocked) {
    fallbackWhere.push('s.catelog <> ?');
    fallbackBinds.push(PRIVATE_BOOKMARK_CATEGORY);
  }

  const fallbackWhereSql = fallbackWhere.length ? `WHERE ${fallbackWhere.join(' AND ')}` : '';

  const fallbackLimitSql = all ? '' : 'LIMIT ? OFFSET ?';
  const fallbackLimitBinds = all ? [] : [safePageSize, offset];

  try {
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
      ${fallbackLimitSql}
    `).bind(...fallbackBinds, ...fallbackLimitBinds).all();

    const countResult = await env.NAV_DB.prepare(`
      SELECT COUNT(*) AS total
      FROM sites s
      ${fallbackWhereSql}
    `).bind(...fallbackBinds).first();

    return {
      data: results || [],
      total: countResult?.total || 0,
      page: safePage,
      pageSize: safePageSize,
    };
  } catch (fallbackError) {
    console.warn(`[sites] legacy list fallback failed: ${fallbackError?.message || fallbackError}`);
    return { data: [], total: 0, page: safePage, pageSize: safePageSize };
  }
}

/**
 * 获取全部站点记录，主要用于后台导出和管理视图。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @returns {Promise<SiteRecord[]>}
 */
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

  // 可见性过滤（docs/adr/0003）：access 存在时应用与 getSites 相同的 SQL 片段；
  // 缺省保持历史形态不过滤（仅测试路径——home/exportConfig 两个生产调用面均显式传 access）
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

/**
 * 按 ID 获取单个站点及其标签。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {number|string} id 站点 ID。
 * @returns {Promise<SiteRecord|null>}
 */
export async function getSite(env, id) {
  const site = await env.NAV_DB.prepare(`
    SELECT ${SITE_SELECT_COLUMNS}
    FROM sites s
    LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.id = ?
  `).bind(id).first();
  if (!site) return null;
  const [withTags] = await attachTagsToSites(env, [site]);
  return withTags;
}

/**
 * 记录一次搜索行为，用于后台搜索统计分析。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {string} [keyword=''] 搜索关键词。
 * @param {number|string} [resultCount=0] 本次搜索结果数量。
 * @returns {Promise<{keyword: string, resultCount: number}|null>}
 */
export async function recordSearchTerm(env, keyword = '', resultCount = 0) {
  const term = cleanText(keyword).slice(0, 80);
  if (!term) return null;
  const count = Math.max(0, Number(resultCount) || 0);
  await env.NAV_DB.prepare(`
    INSERT INTO search_terms (keyword, total_searches, total_results, last_result_count, zero_result_count, first_searched_at, last_searched_at)
    VALUES (?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(keyword) DO UPDATE SET
      total_searches = total_searches + 1,
      total_results = total_results + excluded.last_result_count,
      last_result_count = excluded.last_result_count,
      zero_result_count = zero_result_count + excluded.zero_result_count,
      last_searched_at = CURRENT_TIMESTAMP
  `).bind(term, count, count, count === 0 ? 1 : 0).run();
  return { keyword: term, resultCount: count };
}

export async function getSiteAnalytics(env, { limit = 20, access = null } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));

  // 可见性过滤：与 searchSites 完全相同的 SQL 片段（API 语义 privateUnlocked 含有效 token，
  // ADR-0002；admin 全可见；匿名仅 public + 非私密分类）。access 缺省（null）按匿名处理——
  // 接口级杜绝复漏（曾经匿名 chat 排行泄露 private/admin_only/unlisted 站点）。
  const accessWhere = [];
  const accessBinds = [];
  if (!access || !access.adminAuthed) {
    applyVisibilityWhere(accessWhere, accessBinds, access);
  }
  const accessWhereSql = accessWhere.length ? ` AND ${accessWhere.join(' AND ')}` : '';

  const [topByHits, recentlyActive, categoryHeat, totals, inactive] = await Promise.all([
    env.NAV_DB.prepare(`
      SELECT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE COALESCE(s.hits, 0) > 0${accessWhereSql}
      ORDER BY COALESCE(s.hits, 0) DESC, datetime(COALESCE(s.last_visit_time, s.update_time, s.create_time)) DESC
      LIMIT ?
    `).bind(...accessBinds, safeLimit).all(),
    env.NAV_DB.prepare(`
      SELECT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE s.last_visit_time IS NOT NULL${accessWhereSql}
      ORDER BY datetime(s.last_visit_time) DESC
      LIMIT ?
    `).bind(...accessBinds, safeLimit).all(),
    env.NAV_DB.prepare(`
      SELECT
        COALESCE(c.name, s.catelog, '未分类') AS catelog,
        COUNT(*) AS site_count,
        SUM(COALESCE(s.hits, 0)) AS total_hits,
        AVG(COALESCE(s.hits, 0)) AS avg_hits,
        MAX(datetime(s.last_visit_time)) AS last_visit_time
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      GROUP BY catelog
      ORDER BY total_hits DESC, site_count DESC
      LIMIT ?
    `).bind(safeLimit).all(),
    env.NAV_DB.prepare(`
      SELECT
        COUNT(*) AS total_sites,
        SUM(COALESCE(hits, 0)) AS total_hits,
        SUM(CASE WHEN last_visit_time IS NULL THEN 1 ELSE 0 END) AS never_visited,
        SUM(CASE WHEN datetime(last_visit_time) < datetime('now', '-30 days') THEN 1 ELSE 0 END) AS stale_30d
      FROM sites
    `).first(),
    env.NAV_DB.prepare(`
      SELECT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE (s.last_visit_time IS NULL OR datetime(s.last_visit_time) < datetime('now', '-60 days'))${accessWhereSql}
      ORDER BY
        CASE WHEN s.last_visit_time IS NULL THEN 0 ELSE 1 END ASC,
        datetime(COALESCE(s.last_visit_time, '1970-01-01 00:00:00')) ASC,
        s.id ASC
      LIMIT ?
    `).bind(...accessBinds, safeLimit).all(),
  ]);

  const topByHitsWithTags = await attachTagsToSites(env, topByHits.results || []);
  const recentlyActiveWithTags = await attachTagsToSites(env, recentlyActive.results || []);
  const inactiveWithTags = await attachTagsToSites(env, inactive.results || []);

  return {
    summary: {
      totalSites: Number(totals?.total_sites) || 0,
      totalHits: Number(totals?.total_hits) || 0,
      neverVisited: Number(totals?.never_visited) || 0,
      staleOver30Days: Number(totals?.stale_30d) || 0,
    },
    topByHits: topByHitsWithTags.map((site) => ({
      id: site.id, name: site.name, url: site.url, logo: site.logo,
      catelog: site.catelog, hits: Number(site.hits) || 0, last_visit_time: site.last_visit_time,
    })),
    recentlyActive: recentlyActiveWithTags.map((site) => ({
      id: site.id, name: site.name, url: site.url, logo: site.logo,
      catelog: site.catelog, hits: Number(site.hits) || 0, last_visit_time: site.last_visit_time,
    })),
    categoryHeat: (categoryHeat.results || []).map((row) => ({
      catelog: row.catelog || '未分类',
      siteCount: Number(row.site_count) || 0,
      totalHits: Number(row.total_hits) || 0,
      avgHits: Number((Number(row.avg_hits) || 0).toFixed(1)),
      lastVisitTime: row.last_visit_time,
    })),
    inactiveSites: inactiveWithTags.map((site) => ({
      id: site.id, name: site.name, url: site.url, logo: site.logo,
      catelog: site.catelog, hits: Number(site.hits) || 0, last_visit_time: site.last_visit_time,
    })),
  };
}

export async function getSearchAnalytics(env, { limit = 20 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  const [popular, zeroResults, recent] = await Promise.all([
    env.NAV_DB.prepare(`
      SELECT keyword, total_searches, total_results, last_result_count, zero_result_count, first_searched_at, last_searched_at
      FROM search_terms
      ORDER BY total_searches DESC, last_searched_at DESC
      LIMIT ?
    `).bind(safeLimit).all(),
    env.NAV_DB.prepare(`
      SELECT keyword, total_searches, total_results, last_result_count, zero_result_count, first_searched_at, last_searched_at
      FROM search_terms
      WHERE zero_result_count > 0
      ORDER BY zero_result_count DESC, last_searched_at DESC
      LIMIT ?
    `).bind(safeLimit).all(),
    env.NAV_DB.prepare(`
      SELECT keyword, total_searches, total_results, last_result_count, zero_result_count, first_searched_at, last_searched_at
      FROM search_terms
      ORDER BY datetime(last_searched_at) DESC
      LIMIT ?
    `).bind(safeLimit).all(),
  ]);
  const mapRow = (row) => ({
    keyword: row.keyword,
    totalSearches: Number(row.total_searches) || 0,
    totalResults: Number(row.total_results) || 0,
    lastResultCount: Number(row.last_result_count) || 0,
    zeroResultCount: Number(row.zero_result_count) || 0,
    firstSearchedAt: row.first_searched_at,
    lastSearchedAt: row.last_searched_at,
  });
  return {
    popular: (popular.results || []).map(mapRow),
    zeroResults: (zeroResults.results || []).map(mapRow),
    recent: (recent.results || []).map(mapRow),
  };
}

/**
 * 按 ID 批量读取站点摘要（供“我的常用”模块按需拉取，替代首页全量内联索引）。
 * 可见性过滤与 searchSites 一致：未解锁访客拿不到 private/admin_only/unlisted 与私密分类。
 */
export async function listSitesByIds(env, ids = [], { includePrivate = false, adminAuthed = false, privateUnlocked = includePrivate, access = null } = {}) {
  const resolvedAccess = access || { adminAuthed, privateUnlocked };
  const cleanIds = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))].slice(0, 50);
  if (!cleanIds.length) return [];

  const where = [`s.id IN (${cleanIds.map(() => '?').join(', ')})`];
  const binds = [...cleanIds];
  if (!resolvedAccess.adminAuthed) {
    applyVisibilityWhere(where, binds, resolvedAccess);
  }

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT
        s.id,
        s.name,
        s.url,
        s.logo,
        COALESCE(c.name, s.catelog) AS catelog
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.sort_order ASC, s.id ASC
    `).bind(...binds).all();
    return results || [];
  } catch (error) {
    console.warn(`[siteService] listSitesByIds failed: ${error?.message || error}`);
    return [];
  }
}

/**
 * 全站搜索：关键词 + 高级筛选（tag:/cat:/url:/vis:），支持私密书签可见性。
 */
export async function searchSites(env, { keyword = '', limit = 50, includePrivate = false, adminAuthed = false, privateUnlocked = includePrivate, access = null } = {}) {
  const resolvedAccess = access || { adminAuthed, privateUnlocked };
  const query = parseSearchQuery(keyword);
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  if (!query.raw && !query.terms.length && !Object.values(query.filters).some((value) => Array.isArray(value) ? value.length : value)) return [];

  const where = [];
  const binds = [];
  const likeTerms = [...new Set([
    ...query.terms,
    ...query.filters.tags,
    ...query.filters.categories,
    ...query.filters.urls,
  ])].map((term) => toSafeLikePattern(term)).filter(Boolean).slice(0, 24);

  if (likeTerms.length) {
    const termClauses = [];
    for (const likeTerm of likeTerms) {
      termClauses.push(`(
        s.name LIKE ? ESCAPE '\\'
        OR s.url LIKE ? ESCAPE '\\'
        OR COALESCE(s.desc, '') LIKE ? ESCAPE '\\'
        OR COALESCE(c.name, s.catelog) LIKE ? ESCAPE '\\'
        OR t.name LIKE ? ESCAPE '\\'
      )`);
      binds.push(likeTerm, likeTerm, likeTerm, likeTerm, likeTerm);
    }
    where.push(`(${termClauses.join(' OR ')})`);
  }

  if (query.filters.visibility) {
    where.push("COALESCE(s.visibility, 'public') = ?");
    binds.push(query.filters.visibility);
  }

  if (query.filters.health === 'dead') {
    where.push(deadSiteSql('s'));
  } else if (query.filters.health === 'ok') {
    where.push(okSiteSql('s'));
  }

  if (!resolvedAccess.adminAuthed) {
    applyVisibilityWhere(where, binds, resolvedAccess);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const candidateLimit = Math.max(safeLimit * 6, 80);
  let candidateRows = [];

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT DISTINCT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      LEFT JOIN site_tags st ON st.site_id = s.id
      LEFT JOIN tags t ON t.id = st.tag_id
      ${whereSql}
      ORDER BY datetime(s.update_time) DESC, datetime(s.create_time) DESC
      LIMIT ?
    `).bind(...binds, candidateLimit).all();

    candidateRows = results || [];
  } catch (error) {
    console.warn(`[search] primary query fallback: ${error?.message || error}`);

    const fallbackWhere = [];
    const fallbackBinds = [];
    const rawLike = toSafeLikePattern(query.raw);

    if (rawLike) {
      fallbackWhere.push("(s.name LIKE ? ESCAPE '\\' OR s.url LIKE ? ESCAPE '\\' OR COALESCE(s.desc, '') LIKE ? ESCAPE '\\' OR s.catelog LIKE ? ESCAPE '\\')");
      fallbackBinds.push(rawLike, rawLike, rawLike, rawLike);
    }

    if (!resolvedAccess.adminAuthed && !resolvedAccess.privateUnlocked) {
      fallbackWhere.push('s.catelog <> ?');
      fallbackBinds.push(PRIVATE_BOOKMARK_CATEGORY);
    }

    const fallbackWhereSql = fallbackWhere.length ? `WHERE ${fallbackWhere.join(' AND ')}` : '';

    try {
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
        LIMIT ?
      `).bind(...fallbackBinds, candidateLimit).all();

      candidateRows = (results || []).map((site) => ({ ...site, tags: [] }));
    } catch (fallbackError) {
      console.warn(`[search] legacy query fallback failed: ${fallbackError?.message || fallbackError}`);
      return [];
    }
  }
  const needsBroadRecall = candidateRows.length < safeLimit && query.terms.some((term) => /^[a-z0-9]{2,16}$/i.test(term));
  if (needsBroadRecall) {
    const fallbackWhere = [];
    const fallbackBinds = [];

    if (query.filters.visibility) {
      fallbackWhere.push("COALESCE(s.visibility, 'public') = ?");
      fallbackBinds.push(query.filters.visibility);
    }

    if (query.filters.health === 'dead') {
      fallbackWhere.push(deadSiteSql('s'));
    } else if (query.filters.health === 'ok') {
      fallbackWhere.push(okSiteSql('s'));
    }

    if (!resolvedAccess.adminAuthed) {
      applyVisibilityWhere(fallbackWhere, fallbackBinds, resolvedAccess);
    }

    const fallbackWhereSql = fallbackWhere.length ? `WHERE ${fallbackWhere.join(' AND ')}` : '';
    const { results: fallbackResults } = await env.NAV_DB.prepare(`
      SELECT ${SITE_SELECT_COLUMNS}
      FROM sites s
      LEFT JOIN categories c ON c.id = s.category_id
      ${fallbackWhereSql}
      ORDER BY COALESCE(s.hits, 0) DESC, datetime(s.update_time) DESC, datetime(s.create_time) DESC
      LIMIT 500
    `).bind(...fallbackBinds).all();
    const seen = new Set(candidateRows.map((site) => site.id));
    for (const site of fallbackResults || []) {
      if (!seen.has(site.id)) {
        candidateRows.push(site);
        seen.add(site.id);
      }
    }
  }

  let withTags = candidateRows;
  try {
    withTags = await attachTagsToSites(env, candidateRows);
  } catch (tagError) {
    console.warn(`[search] attach tags skipped: ${tagError?.message || tagError}`);
    withTags = candidateRows.map((site) => ({ ...site, tags: Array.isArray(site.tags) ? site.tags : [] }));
  }

  return withTags
    .filter((site) => matchesAdvancedFilters(site, query.filters))
    .map((site) => {
      const scored = scoreSite(site, query.terms.length ? query.terms : [query.raw]);
      return {
        ...site,
        _score: scored.score,
        _matchedFields: scored.matchedFields,
        _matchReasons: scored.matchReasons,
      };
    })
    .filter((site) => site._matchedFields.length > 0 || !query.terms.length)
    .sort((a, b) => {
      const scoreDiff = (Number(b._score) || 0) - (Number(a._score) || 0);
      if (scoreDiff !== 0) return scoreDiff;
      const hitsDiff = (Number(b.hits) || 0) - (Number(a.hits) || 0);
      if (hitsDiff !== 0) return hitsDiff;
      return String(b.update_time || b.create_time || '').localeCompare(String(a.update_time || a.create_time || ''));
    })
    .slice(0, safeLimit);
}

export async function incrementSiteHits(env, id) {
  return env.NAV_DB.prepare(`
    UPDATE sites
    SET hits = COALESCE(hits, 0) + 1,
        last_visit_time = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(id).run();
}


export function buildDuplicateError(duplicate, scope = 'site') {
  const summary = duplicate?.name ? `${duplicate.name}（${duplicate.url}）` : duplicate?.url || '';
  const error = new Error(`Duplicate URL: 已存在书签 #${duplicate?.id} ${summary}`);
  error.code = 'DUPLICATE_URL';
  error.scope = scope;
  error.duplicate = duplicate;
  return error;
}

/**
 * 创建书签站点。
 *
 * 默认会进行 URL 去重校验；当 `force=true` 时允许跳过重复检查，供管理员确认覆盖风险后使用。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {SitePayload} config 站点创建参数。
 * @param {object} [options] 创建选项。
 * @param {boolean} [options.force=false] 是否强制创建并跳过重复 URL 校验。
 * @returns {Promise<object>} D1 写入结果。
 * @throws {Error} 当必填字段缺失或 URL 重复时抛出错误。
 */
export async function createSite(env, config, { force = false, ip } = {}) {
  const site = normalizeSitePayload(config);
  const spaceId = null;
  if (!force) {
    const duplicate = await findDuplicateSite(env, site.url);
    if (duplicate) throw buildDuplicateError(duplicate, 'create');
  }
  if (!hasExplicitSortOrder(config)) {
    site.sort_order = await getPrependSortOrder(env, spaceId);
  }
  const category = await upsertCategoryByName(env, site.catelog, site.sort_order);

  const result = await env.NAV_DB.prepare(`
    INSERT INTO sites (name, url, logo, desc, catelog, category_id, space_id, visibility, sort_order, url_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(site.name, site.url, site.logo, site.desc, site.catelog, category?.id || null, spaceId, site.visibility, site.sort_order, normalizeDuplicateUrlKey(site.url)).run();

  const siteId = result?.meta?.last_row_id;
  if (siteId) await setSiteTags(env, siteId, site.tags);
  await logOperation(env, {
    action: OPERATION_LOG_ACTIONS.SITE_CREATE,
    target: 'site',
    targetId: siteId,
    summary: site.name,
    ip,
  });
  return result;
}

/**
 * 更新书签站点。
 *
 * 会保留未显式传入的可见性和排序值，并默认校验 URL 是否与其他站点重复。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {number|string} id 站点 ID。
 * @param {SitePayload} config 站点更新参数。
 * @param {object} [options] 更新选项。
 * @param {boolean} [options.force=false] 是否强制更新并跳过重复 URL 校验。
 * @returns {Promise<object>} D1 更新结果。
 * @throws {Error} 当站点不存在、必填字段缺失或 URL 重复时抛出错误。
 */
export async function updateSite(env, id, config, { force = false, ip } = {}) {
  const existing = await getSite(env, id);
  if (!existing) throw new Error('Site not found');
  const site = normalizeSitePayload({
    ...config,
    visibility: config?.visibility ?? existing.visibility,
    sort_order: hasExplicitSortOrder(config) ? config.sort_order : existing.sort_order,
  });
  if (!force) {
    const duplicate = await findDuplicateSite(env, site.url, { excludeId: id });
    if (duplicate) throw buildDuplicateError(duplicate, 'update');
  }
  const spaceId = site.space_id || existing.space_id || null;
  const category = await upsertCategoryByName(env, site.catelog, site.sort_order);

  const result = await env.NAV_DB.prepare(`
    UPDATE sites
    SET name = ?, url = ?, logo = ?, desc = ?, catelog = ?, category_id = ?, space_id = ?, visibility = ?, sort_order = ?, url_key = ?, update_time = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(site.name, site.url, site.logo, site.desc, site.catelog, category?.id || null, spaceId, site.visibility, site.sort_order, normalizeDuplicateUrlKey(site.url), id).run();

  await setSiteTags(env, id, site.tags);

  // 编辑书签 = 手动操作：清除自动补全的失败标记（重置后点击可再触发）。
  // 可选链容错无 NAV_AUTH 的测试 env。
  await env.NAV_AUTH?.delete?.(faviconFailedKey(id)).catch(() => {});
  await logOperation(env, {
    action: OPERATION_LOG_ACTIONS.SITE_UPDATE,
    target: 'site',
    targetId: id,
    summary: site.name,
    ip,
  });

  return result;
}

/**
 * 删除书签站点及其标签关联。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB`。
 * @param {number|string} id 站点 ID。
 * @returns {Promise<object>} D1 删除结果。
 */
export async function deleteSite(env, id, { ip } = {}) {
  await env.NAV_DB.prepare('DELETE FROM site_tags WHERE site_id = ?').bind(id).run();
  const result = await env.NAV_DB.prepare('DELETE FROM sites WHERE id = ?').bind(id).run();
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_DELETE, target: 'site', targetId: id, ip });
  return result;
}



export async function bulkDeleteSites(env, ids, { ip } = {}) {
  const siteIds = normalizeIdList(ids);
  if (!siteIds.length) throw new Error('ids must be a non-empty array');

  const placeholders = siteIds.map(() => '?').join(',');
  await env.NAV_DB.prepare(`DELETE FROM site_tags WHERE site_id IN (${placeholders})`).bind(...siteIds).run();
  const result = await env.NAV_DB.prepare(`DELETE FROM sites WHERE id IN (${placeholders})`).bind(...siteIds).run();
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_BULK_DELETE, target: 'site', summary: `批量删除 ${siteIds.length} 个书签`, detail: { ids: siteIds }, ip });
  return result;
}

export async function bulkUpdateSites(env, { ids = [], catelog, tags, mode = 'replace', visibility } = {}, { ip } = {}) {
  const siteIds = normalizeIdList(ids);
  if (!siteIds.length) throw new Error('ids must be a non-empty array');

  const updates = [];
  const binds = [];
  const category = cleanText(catelog);
  const normalizedVisibility = visibility !== undefined && visibility !== null && visibility !== '' ? normalizeVisibility(visibility) : '';
  const hasTags = tags !== undefined && tags !== null;
  const tagList = hasTags ? normalizeTags(tags) : [];

  if (category) {
    const categoryRecord = await upsertCategoryByName(env, category, 9999);
    updates.push('catelog = ?');
    binds.push(category);
    updates.push('category_id = ?');
    binds.push(categoryRecord?.id || null);
  }

  if (normalizedVisibility) {
    updates.push('visibility = ?');
    binds.push(normalizedVisibility);
  }

  if (updates.length) {
    const placeholders = siteIds.map(() => '?').join(',');
    await env.NAV_DB.prepare(`
      UPDATE sites
      SET ${updates.join(', ')}, update_time = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders})
    `).bind(...binds, ...siteIds).run();
  }

  if (hasTags) {
    for (const siteId of siteIds) {
      if (mode === 'append') {
        const [site] = await attachTagsToSites(env, [{ id: siteId }]);
        await setSiteTags(env, siteId, normalizeTags([...(site?.tags || []), ...tagList]));
      } else {
        await setSiteTags(env, siteId, tagList);
      }
    }
  }

  if (!updates.length && !hasTags) throw new Error('No bulk update fields provided');
  const fields = [];
  if (category) fields.push(`分类=${category}`);
  if (normalizedVisibility) fields.push(`可见性=${normalizedVisibility}`);
  if (hasTags) fields.push(`标签(${mode})`);
  await logOperation(env, {
    action: OPERATION_LOG_ACTIONS.SITE_BULK_UPDATE,
    target: 'site',
    summary: `批量修改 ${siteIds.length} 个书签 ${fields.join(' ')}`.trim(),
    detail: { ids: siteIds, fields },
    ip,
  });

  return { updated: siteIds.length };
}

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

export async function findDuplicateSite(env, url, { excludeId = null } = {}) {
  const key = normalizeDuplicateUrlKey(url);
  if (!key) return null;
  // 通过 url_key 索引点查，避免全表扫描 + 全量 JS 规范化（依赖迁移已回填 url_key）。
  const row = excludeId
    ? await env.NAV_DB.prepare('SELECT id, name, url, catelog FROM sites WHERE url_key = ? AND id <> ? LIMIT 1').bind(key, Number(excludeId)).first()
    : await env.NAV_DB.prepare('SELECT id, name, url, catelog FROM sites WHERE url_key = ? LIMIT 1').bind(key).first();
  return row ? { id: row.id, name: row.name, url: row.url, catelog: row.catelog } : null;
}

// 预览抓取簇（fetchSitePreview + meta 抽取）已迁入 lib/sitePreview.js
// （2026-08-16 架构评审候选 4，零 D1 依赖，与 lib/favicon.js 同族）；
// re-export 垫片保持存量测试与调用方 import 面不变，同 ADR-0003 模式。
export { fetchSitePreview } from '../lib/sitePreview.js';


export async function reorderSites(env, items, { ip } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must be a non-empty array');
  }

  console.log(`[api] reorder sites count=${items.length}`);

  const statements = items.map((item, index) => {
    const id = Number(item.id);
    if (!Number.isFinite(id)) throw new Error('Invalid site id');
    const sortOrder = normalizeSortOrder(item.sort_order, (index + 1) * 10);
    return env.NAV_DB.prepare('UPDATE sites SET sort_order = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?').bind(sortOrder, id);
  });

  await env.NAV_DB.batch(statements);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_REORDER, target: 'site', summary: `重排 ${items.length} 个书签`, ip });
}