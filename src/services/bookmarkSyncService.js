import { cleanText } from '../lib/utils.js';
import { normalizeDuplicateUrlKey } from './siteService.js';
import { upsertCategoryByName } from './categoryService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';

export const SYNC_SOURCE_MANUAL = 'manual';
export const SYNC_SOURCE_BROWSER = 'browser';

export const SYNC_EMPTY_SNAPSHOT_ERROR = 'EMPTY_SNAPSHOT';

const UNCATEGORIZED = '未分类';
const BATCH_SIZE = 100;

function chunk(items, size) {
  const batches = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** 取文件夹路径的叶子名（最后一个分段）；空路径归「未分类」。 */
function categoryFromFolderPath(folderPath) {
  const text = cleanText(folderPath);
  if (!text) return UNCATEGORIZED;
  const segments = text.split('/').map((s) => s.trim()).filter(Boolean);
  return segments.length ? segments[segments.length - 1] : UNCATEGORIZED;
}

/**
 * 按文件夹路径建父子分类树（缺失即创建，复用已有同名分类）：
 * '工作/开发' → 工作（无父级）+ 开发（父=工作）；空路径 → 未分类。
 * @returns {Promise<{catelog: string, categoryId: number|null}>} 叶子分类信息
 */
async function ensureCategoryPath(env, folderPath) {
  const text = cleanText(folderPath);
  const segments = text ? text.split('/').map((s) => s.trim()).filter(Boolean) : [];
  if (segments.length === 0) {
    const category = await upsertCategoryByName(env, UNCATEGORIZED, 9999);
    return { catelog: UNCATEGORIZED, categoryId: category?.id || null };
  }
  let parentId = null;
  let leaf = null;
  for (const seg of segments) {
    await env.NAV_DB.batch([
      env.NAV_DB.prepare(
        'INSERT INTO categories (name, parent_id, sort_order) VALUES (?, ?, ?) ON CONFLICT(name) DO NOTHING'
      ).bind(seg, parentId, 9999),
      env.NAV_DB.prepare(
        'INSERT INTO category_orders (catelog, sort_order) VALUES (?, ?) ON CONFLICT(catelog) DO NOTHING'
      ).bind(seg, 9999),
    ]);
    const row = await env.NAV_DB.prepare('SELECT * FROM categories WHERE name = ?').bind(seg).first();
    if (!row) return leaf || { catelog: UNCATEGORIZED, categoryId: null };
    leaf = { catelog: row.name, categoryId: row.id };
    parentId = row.id;
  }
  return leaf;
}

/**
 * 规范化同步快照条目。返回 { valid, failed }：
 * - valid: [{ id, title, url, folderPath, key }]，key 为空视为非法
 * - failed: [{ url, reason }]
 * 无 URL（文件夹节点/空条目）与无法规范化 URL 的条目进 failed，不阻塞其余条目。
 */
export function normalizeSyncSnapshot(items) {
  const valid = [];
  const failed = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const title = cleanText(raw?.title) || '';
    const url = cleanText(raw?.url);
    if (!url) {
      failed.push({ url: '', reason: '缺少 URL' });
      continue;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      failed.push({ url, reason: '仅支持 http/https 书签' });
      continue;
    }
    const key = normalizeDuplicateUrlKey(url);
    if (!key) {
      failed.push({ url, reason: 'URL 无法规范化' });
      continue;
    }
    valid.push({
      id: raw?.id ? String(raw.id) : null,
      title: title || url,
      url,
      folderPath: cleanText(raw?.folderPath),
      key,
    });
  }
  return { valid, failed };
}

/**
 * 以浏览器收藏快照为事实源对齐同步书签：
 * - 快照含而 StarNav 无（URL 不撞手动书签）→ 新增（sync_source='browser'）
 * - ID 或 url_key 命中同步书签 → 更新 name/url/catelog（仅这三字段）
 * - 命中手动书签 → 跳过（手动优先）
 * - 快照不包含的同步书签 → 删除（删除前写 operation_logs）
 * 空快照/全非法快照 → 抛 SYNC_EMPTY_SNAPSHOT_ERROR，零写入。
 *
 * @returns {Promise<{stats: {added, updated, deleted, skipped, failed}, failedItems: Array}>}
 */
export async function syncBookmarks(env, items, { source = 'extension', request, dryRun = false } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(SYNC_EMPTY_SNAPSHOT_ERROR);
  }
  const { valid, failed } = normalizeSyncSnapshot(items);
  if (valid.length === 0) {
    // 全非法快照等价于空快照：对齐会删光所有同步书签，拒绝执行
    throw new Error(SYNC_EMPTY_SNAPSHOT_ERROR);
  }

  const { results: browserSites } = await env.NAV_DB
    .prepare('SELECT * FROM sites WHERE sync_source = ?')
    .bind(SYNC_SOURCE_BROWSER)
    .all();

  const byKey = new Map();
  const byId = new Map();
  for (const site of browserSites || []) {
    const key = normalizeDuplicateUrlKey(site.url);
    if (key && !byKey.has(key)) byKey.set(key, site);
    if (site.browser_bookmark_id && !byId.has(site.browser_bookmark_id)) byId.set(site.browser_bookmark_id, site);
  }

  const { results: manualRows } = await env.NAV_DB
    .prepare("SELECT url FROM sites WHERE sync_source IS NULL OR sync_source != ?")
    .bind(SYNC_SOURCE_BROWSER)
    .all();
  const manualKeys = new Set(
    (manualRows || []).map((row) => normalizeDuplicateUrlKey(row.url)).filter(Boolean)
  );

  const seenKeys = new Set();
  const matchedIds = new Set();
  const toInsert = [];
  const toUpdate = [];
  let skipped = 0;

  for (const item of valid) {
    const key = item.key;
    let site = item.id ? byId.get(item.id) : undefined;
    if (site) {
      matchedIds.add(site.id);
      seenKeys.add(key);
      const catelog = categoryFromFolderPath(item.folderPath);
      if (site.name !== item.title || site.url !== item.url || site.catelog !== catelog) {
        toUpdate.push({ id: site.id, name: item.title, url: item.url, url_key: key, catelog, folderPath: item.folderPath || '' });
      }
      continue;
    }
    if (seenKeys.has(key)) {
      skipped += 1;
      continue;
    }
    site = byKey.get(key);
    if (site) {
      matchedIds.add(site.id);
      seenKeys.add(key);
      const catelog = categoryFromFolderPath(item.folderPath);
      if (site.name !== item.title || site.catelog !== catelog) {
        toUpdate.push({ id: site.id, name: item.title, url: site.url, url_key: site.url_key || key, catelog, folderPath: item.folderPath || '' });
      }
      continue;
    }
    if (manualKeys.has(key)) {
      skipped += 1;
      continue;
    }
    seenKeys.add(key);
    toInsert.push(item);
  }

  const toDelete = (browserSites || []).filter((site) => !matchedIds.has(site.id));
  if (!dryRun) {
    for (const site of toDelete) {
      await logOperation(env, {
        action: OPERATION_LOG_ACTIONS.SYNC_BOOKMARK_DELETE,
        target: 'site',
        targetId: site.id,
        summary: site.name || '',
        detail: { url: site.url, reason: 'browser snapshot no longer contains this bookmark' },
        request,
      });
    }
  }

  // 分类：按文件夹路径建父子分类树（只新建缺失，复用同名分类）
  const paths = new Set([
    ...toInsert.map((item) => cleanText(item.folderPath) || ''),
    ...toUpdate.map((u) => u.folderPath || ''),
  ]);
  const categoryByPath = new Map();
  if (!dryRun) {
    for (const path of paths) {
      categoryByPath.set(path, await ensureCategoryPath(env, path));
    }
  }

  // 新增
  for (const batch of chunk(toInsert, BATCH_SIZE)) {
    if (dryRun) break;
    await env.NAV_DB.batch(
      batch.map((item) => {
        const path = cleanText(item.folderPath) || '';
        const resolved = categoryByPath.get(path) || { catelog: categoryFromFolderPath(path), categoryId: null };
        return env.NAV_DB
          .prepare(
            `INSERT INTO sites (name, url, logo, desc, catelog, category_id, space_id, visibility, sort_order, url_key, sync_source, browser_bookmark_id)
             VALUES (?, ?, NULL, NULL, ?, ?, NULL, 'public', 9999, ?, ?, ?)`
          )
          .bind(
            item.title,
            item.url,
            resolved.catelog,
            resolved.categoryId,
            item.key,
            SYNC_SOURCE_BROWSER,
            item.id
          );
      })
    );
  }

  // 更新：仅 name/url/catelog/url_key
  for (const batch of chunk(toUpdate, BATCH_SIZE)) {
    if (dryRun) break;
    await env.NAV_DB.batch(
      batch.map((u) => {
        const resolved = categoryByPath.get(u.folderPath || '') || { catelog: u.catelog, categoryId: null };
        return env.NAV_DB
          .prepare(
            `UPDATE sites SET name = ?, url = ?, catelog = ?, category_id = ?, url_key = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?`
          )
          .bind(
            u.name,
            u.url,
            resolved.catelog,
            resolved.categoryId,
            u.url_key,
            u.id
          );
      })
    );
  }

  // 删除
  for (const batch of chunk(toDelete, BATCH_SIZE)) {
    if (dryRun) break;
    await env.NAV_DB.batch(
      batch.map((site) => env.NAV_DB.prepare('DELETE FROM sites WHERE id = ?').bind(site.id))
    );
  }

  return {
    stats: {
      added: toInsert.length,
      updated: toUpdate.length,
      deleted: toDelete.length,
      skipped,
      failed: failed.length,
    },
    failedItems: failed,
    deletedItems: toDelete.map((site) => ({ id: site.id, name: site.name, url: site.url })),
  };
}

/**
 * 解除同步：sync_source 置 manual 并清除浏览器书签 ID，此后不再参与对齐。
 * @returns {Promise<{changed: boolean, exists: boolean}>}
 */
export async function unsyncSite(env, id) {
  const siteId = Number(id);
  if (!Number.isFinite(siteId) || siteId <= 0) return { changed: false, exists: false };
  const result = await env.NAV_DB
    .prepare('UPDATE sites SET sync_source = ?, browser_bookmark_id = NULL, update_time = CURRENT_TIMESTAMP WHERE id = ? AND sync_source = ?')
    .bind(SYNC_SOURCE_MANUAL, siteId, SYNC_SOURCE_BROWSER)
    .run();
  if ((result?.meta?.changes || 0) > 0) return { changed: true, exists: true };
  const row = await env.NAV_DB.prepare('SELECT 1 AS found FROM sites WHERE id = ?').bind(siteId).first();
  return { changed: false, exists: Boolean(row) };
}
