// 导入/导出域：书签 JSON 导入（preview/import，merge/overwrite 两模式）与全量导出（exportConfig）。
// 自 siteService 拆出（2026-08-16 架构评审候选 5，纯搬迁）；siteService 保留同名 re-export 垫片，
// 存量测试与调用方 import 面不变（同 ADR-0003 模式）；backupService 直接改从本模块 import。
// sites 表的共享 helper（载荷规范化 / 去重键 / 全量读取）仍由 siteService 单一持有，此处 import 复用。
// operation_logs 记录随函数内联迁入（ADR-0004 约定写服务内部记录）。
import { cleanText, normalizeSortOrder } from '../lib/utils.js';
import { upsertCategoryByName } from './categoryService.js';
import { setSiteTags } from './tagService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';
import { getAllSites, normalizeDuplicateUrlKey, normalizeSitePayload } from './siteCore.js';

export function normalizeImportPayload(jsonData) {
  if (Array.isArray(jsonData)) {
    return { sites: jsonData, categories: [] };
  }

  if (jsonData && typeof jsonData === 'object') {
    if (Array.isArray(jsonData.sites)) {
      return {
        sites: jsonData.sites,
        categories: Array.isArray(jsonData.categories) ? jsonData.categories : [],
      };
    }

    if (Array.isArray(jsonData.data)) {
      return { sites: jsonData.data, categories: Array.isArray(jsonData.categories) ? jsonData.categories : [] };
    }
  }

  throw new Error('Invalid JSON data. Must be an array, { data: [...] }, or { sites: [...], categories: [...] }.');
}

async function getExistingUrlKeySet(env) {
  const { results } = await env.NAV_DB.prepare('SELECT url FROM sites').all();
  return new Set((results || []).map((row) => normalizeDuplicateUrlKey(row.url)).filter(Boolean));
}

export async function previewImportSites(env, jsonData, { mode = 'merge' } = {}) {
  const { sites, categories } = normalizeImportPayload(jsonData);
  const overwrite = cleanText(mode).toLowerCase() === 'overwrite';
  const existingKeys = overwrite ? new Set() : await getExistingUrlKeySet(env);
  const seenKeys = new Set();
  const categoryNames = new Set();
  const missingCategories = new Set();
  const samples = { valid: [], invalid: [], duplicateExisting: [], duplicateInFile: [] };
  let validSites = 0;
  let invalidSites = 0;
  let duplicateExisting = 0;
  let duplicateInFile = 0;

  for (const item of sites) {
    try {
      const site = normalizeSitePayload(item);
      const key = normalizeDuplicateUrlKey(site.url);
      categoryNames.add(site.catelog);
      if (existingKeys.has(key)) {
        duplicateExisting += 1;
        if (samples.duplicateExisting.length < 5) samples.duplicateExisting.push({ name: site.name, url: site.url, catelog: site.catelog });
        continue;
      }
      if (seenKeys.has(key)) {
        duplicateInFile += 1;
        if (samples.duplicateInFile.length < 5) samples.duplicateInFile.push({ name: site.name, url: site.url, catelog: site.catelog });
        continue;
      }
      seenKeys.add(key);
      validSites += 1;
      if (samples.valid.length < 5) samples.valid.push({ name: site.name, url: site.url, catelog: site.catelog });
    } catch (error) {
      invalidSites += 1;
      if (samples.invalid.length < 5) samples.invalid.push({ name: cleanText(item?.name), url: cleanText(item?.url), reason: error.message });
    }
  }

  const importedCategoryNames = new Set(categories.map((category) => cleanText(category?.name || category?.catelog)).filter(Boolean));
  const { results: existingCategories } = await env.NAV_DB.prepare('SELECT name FROM categories').all();
  const existingCategoryNames = new Set((existingCategories || []).map((row) => cleanText(row.name)).filter(Boolean));
  for (const name of categoryNames) {
    if (!existingCategoryNames.has(name) && !importedCategoryNames.has(name)) missingCategories.add(name);
  }

  return {
    totalSites: sites.length,
    validSites,
    invalidSites,
    duplicateExisting,
    duplicateInFile,
    importableSites: validSites,
    categoriesInFile: importedCategoryNames.size,
    categoriesUsed: categoryNames.size,
    missingCategories: [...missingCategories],
    willCreateCategories: [...new Set([...importedCategoryNames, ...missingCategories])],
    samples,
  };
}

async function clearBookmarkData(env) {
  await env.NAV_DB.batch([
    env.NAV_DB.prepare('DELETE FROM site_tags'),
    env.NAV_DB.prepare('DELETE FROM sites'),
    env.NAV_DB.prepare('DELETE FROM tags'),
    env.NAV_DB.prepare('DELETE FROM categories'),
    env.NAV_DB.prepare('DELETE FROM category_orders'),
    env.NAV_DB.prepare('DELETE FROM category_metadata'),
  ]);
}

async function restoreImportCategories(env, categories = []) {
  const normalized = categories
    .map((category) => ({
      oldId: category?.id,
      name: cleanText(category?.name || category?.catelog),
      parentId: category?.parent_id,
      sortOrder: normalizeSortOrder(category?.sort_order),
      icon: cleanText(category?.icon) || null,
      description: cleanText(category?.description) || null,
    }))
    .filter((category) => category.name);

  for (const category of normalized) {
    await env.NAV_DB.batch([
      env.NAV_DB.prepare(`
        INSERT INTO categories (name, sort_order, icon, description)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          sort_order = excluded.sort_order,
          icon = excluded.icon,
          description = excluded.description,
          update_time = CURRENT_TIMESTAMP
      `).bind(category.name, category.sortOrder, category.icon, category.description),
      env.NAV_DB.prepare(`
        INSERT INTO category_orders (catelog, sort_order)
        VALUES (?, ?)
        ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order
      `).bind(category.name, category.sortOrder),
    ]);
  }

  const currentCategories = await listCategoryIdMap(env);
  const oldIdToName = new Map(normalized.map((category) => [String(category.oldId), category.name]));
  for (const category of normalized) {
    if (!category.parentId) continue;
    const parentName = oldIdToName.get(String(category.parentId));
    const parent = parentName ? currentCategories.get(parentName) : null;
    const current = currentCategories.get(category.name);
    if (parent?.id && current?.id && parent.id !== current.id) {
      await env.NAV_DB.prepare('UPDATE categories SET parent_id = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?').bind(parent.id, current.id).run();
    }
  }
}

async function listCategoryIdMap(env) {
  const { results } = await env.NAV_DB.prepare('SELECT id, name FROM categories').all();
  return new Map((results || []).map((row) => [row.name, row]));
}

export async function importSites(env, jsonData, { mode = 'merge', ip } = {}) {
  const { sites, categories } = normalizeImportPayload(jsonData);
  const overwrite = cleanText(mode).toLowerCase() === 'overwrite';
  if (overwrite) await clearBookmarkData(env);

  const existingKeys = overwrite ? new Set() : await getExistingUrlKeySet(env);
  const seenKeys = new Set();
  let importedSites = 0;

  await restoreImportCategories(env, categories);

  for (const item of sites) {
    try {
      const site = normalizeSitePayload(item);
      const key = normalizeDuplicateUrlKey(site.url);
      if (!key || existingKeys.has(key) || seenKeys.has(key)) {
        console.log(`[import] skipped duplicate site: ${site.url}`);
        continue;
      }
      seenKeys.add(key);
      const spaceId = null;
      const category = await upsertCategoryByName(env, site.catelog, site.sort_order);
      const result = await env.NAV_DB.prepare(`
        INSERT INTO sites (name, url, logo, desc, catelog, category_id, space_id, visibility, sort_order, url_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(site.name, site.url, site.logo, site.desc, site.catelog, category?.id || null, spaceId, site.visibility, site.sort_order, key).run();
      const siteId = result?.meta?.last_row_id;
      if (siteId) await setSiteTags(env, siteId, site.tags);
      importedSites += 1;
    } catch (error) {
      console.log(`[import] skipped invalid site: ${error.message}`);
    }
  }

  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_IMPORT, target: 'site', summary: `${mode} 导入 ${importedSites} 个书签`, ip });
  return importedSites;
}

export async function exportConfig(env) {
  const sites = await getAllSites(env, { access: { adminAuthed: true } });
  const { results: categories } = await env.NAV_DB.prepare(`
    SELECT id, name, parent_id, sort_order, icon, description
    FROM categories
    ORDER BY sort_order ASC, name ASC
  `).all();

  return {
    sites,
    categories: categories || [],
  };
}
