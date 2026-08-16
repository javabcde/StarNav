import { buildTree, cleanText, normalizeSortOrder } from '../lib/utils.js';
import { PRIVATE_BOOKMARK_CATEGORY } from './privateBookmarkService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';

/**
 * 分类颜色值统一安全校验（2026-08-16 架构评审候选 7）。
 * 此前 categoryService.cleanCategoryColor（入库白名单）与 home/categories.js
 * getCategoryCssColor（渲染校验）各持一套正则，命名色集合与 gradient 判定已分歧。
 * 统一语义（并轨为一套，渲染端宽松形态保留为显式分支）：
 *   - 恶意载荷一律拒绝（引号/尖括号/花括号/分号 + url/javascript/expression/behavior/@import）；
 *   - 合法值：hex 3/6 位、rgba()/hsla()、linear-gradient()、CSS 颜色名（含 Tailwind 色板）。
 * 返回规范化后的颜色值（命名色小写）或 null。消费方禁止再手写第二套正则。
 */
export function normalizeCategoryColor(value) {
  const text = cleanText(value);
  if (!text) return null;

  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/[;"'{}<>]/.test(normalized) || /(?:url|javascript|expression|behavior|@import)/i.test(normalized)) {
    return null;
  }

  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(normalized)) return normalized;
  if (/^rgba?\([^)]+\)$/i.test(normalized) || /^hsla?\([^)]+\)$/i.test(normalized)) return normalized;
  if (/^linear-gradient\(/i.test(normalized)) return normalized;
  // CSS 颜色名（含 primary/accent/secondary 与 Tailwind 色板，均落此规则；命名色统一小写）
  if (/^[a-z][a-z0-9-]{1,30}$/i.test(normalized)) return normalized.toLowerCase();
  return null;
}

function cleanCategoryColor(value) {
  return normalizeCategoryColor(value);
}

async function getDescendantCategoryIds(env, categoryId) {
  const { results } = await env.NAV_DB.prepare(`
    WITH RECURSIVE descendants(id) AS (
      SELECT id FROM categories WHERE parent_id = ?
      UNION ALL
      SELECT c.id FROM categories c
      INNER JOIN descendants d ON c.parent_id = d.id
    )
    SELECT id FROM descendants
  `).bind(categoryId).all();

  return (results || []).map((row) => Number(row.id)).filter(Boolean);
}

// ── 分类子孙闭包单一源（2026-08-16 架构评审候选 5）───────────────
// 「点父分类看到父 + 全部子孙分类」语义此前有三份实现：本文件 getDescendantCategoryIds（id 集）、
// siteService.getSites 内联 CTE（name 集）、home.js 树递归（name 集），互相靠注释声称一致。
// 现统一收编本模块：SQL 侧 getDescendantCategoryIds / getDescendantCategoryNames，
// 树侧 collectCategoryWithDescendants（消费已加载分类树，避免渲染路径多一次 D1 往返）。
// 两套实现同文件相邻、同注释族；消费方禁止再手写第三份。

/**
 * 解析某分类及其全部子孙分类名（SQL 递归 CTE；失败回退为仅精确匹配名）。
 */
export async function getDescendantCategoryNames(env, name) {
  let names = [name];
  try {
    const { results } = await env.NAV_DB.prepare(`
      WITH RECURSIVE cat_tree(id, name) AS (
        SELECT id, name FROM categories WHERE name = ?
        UNION ALL
        SELECT c.id, c.name FROM categories c JOIN cat_tree ct ON c.parent_id = ct.id
      )
      SELECT name FROM cat_tree
    `).bind(name).all();
    if (results && results.length) names = results.map((row) => row.name);
  } catch (error) {
    console.warn(`[categories] category tree resolve fallback: ${error?.message || error}`);
  }
  return names;
}

/**
 * 在已加载分类树上收集目标分类及其全部子孙分类名（纯函数，Set 返回）。
 * 与 getDescendantCategoryNames 语义一致，供渲染路径复用内存树。
 */
export function collectCategoryWithDescendants(nodes, targetName, acc = new Set()) {
  for (const node of nodes) {
    if (node.name === targetName) {
      collectSubtreeNames(node, acc);
      return acc;
    }
    if (Array.isArray(node.children) && node.children.length) {
      collectCategoryWithDescendants(node.children, targetName, acc);
    }
  }
  return acc;
}

function collectSubtreeNames(node, acc) {
  acc.add(node.name);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectSubtreeNames(child, acc);
  }
}

async function ensurePrivateBookmarkCategory(env) {
  const legacyPrivateDescription = String.fromCharCode(38656,35201,35775,38382,23494,30721,30340,31169,20154,20070,31614,20998,31867);
  try {
    await env.NAV_DB.batch([
      env.NAV_DB.prepare(`
        INSERT INTO categories (name, sort_order, icon, description)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(name) DO NOTHING
      `).bind(PRIVATE_BOOKMARK_CATEGORY, 2147483647, null, null),
      env.NAV_DB.prepare(`
        INSERT INTO category_orders (catelog, sort_order)
        VALUES (?, ?)
        ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order
      `).bind(PRIVATE_BOOKMARK_CATEGORY, 2147483647),
      env.NAV_DB.prepare(`
        UPDATE categories
        SET
          icon = CASE WHEN icon = 'lock' THEN NULL ELSE icon END,
          description = CASE WHEN description = ? THEN NULL ELSE description END,
          update_time = CURRENT_TIMESTAMP
        WHERE name = ? AND (icon = 'lock' OR description = ?)
      `).bind(legacyPrivateDescription, PRIVATE_BOOKMARK_CATEGORY, legacyPrivateDescription),
    ]);
  } catch (error) {
    console.warn(`[categories] private category full ensure fallback: ${error?.message || error}`);
    try {
      await env.NAV_DB.prepare(`
        INSERT INTO categories (name, sort_order)
        VALUES (?, ?)
        ON CONFLICT(name) DO NOTHING
      `).bind(PRIVATE_BOOKMARK_CATEGORY, 2147483647).run();
    } catch (fallbackError) {
      console.warn(`[categories] private category minimal ensure skipped: ${fallbackError?.message || fallbackError}`);
    }
  }
}

export async function listCategories(env, { space = '' } = {}) {
  await ensurePrivateBookmarkCategory(env);

  const where = [];
  const binds = [];
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT
        c.*,
        (SELECT COUNT(*) FROM sites s WHERE s.category_id = c.id OR (s.category_id IS NULL AND s.catelog = c.name)) AS site_count,
        (SELECT COUNT(*) FROM categories child WHERE child.parent_id = c.id) AS child_count
      FROM categories c
      ${whereSql}
      ORDER BY c.sort_order ASC, c.name ASC
    `).bind(...binds).all();

    return results || [];
  } catch (error) {
    console.warn(`[categories] list fallback: ${error?.message || error}`);
  }

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT
        c.id,
        c.name,
        NULL AS parent_id,
        9999 AS sort_order,
        NULL AS icon,
        NULL AS color,
        NULL AS description,
        COUNT(s.id) AS site_count,
        0 AS child_count
      FROM categories c
      LEFT JOIN sites s ON s.catelog = c.name
      GROUP BY c.id, c.name
      ORDER BY c.name ASC
    `).all();

    return results || [];
  } catch (legacyError) {
    console.warn(`[categories] legacy list fallback: ${legacyError?.message || legacyError}`);
  }

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT
        ROW_NUMBER() OVER (ORDER BY catelog ASC) AS id,
        catelog AS name,
        NULL AS parent_id,
        9999 AS sort_order,
        NULL AS icon,
        NULL AS color,
        NULL AS description,
        COUNT(*) AS site_count,
        0 AS child_count
      FROM sites
      WHERE COALESCE(TRIM(catelog), '') <> ''
      GROUP BY catelog
      ORDER BY catelog ASC
    `).all();

    return results || [];
  } catch (sitesOnlyError) {
    console.warn(`[categories] sites-only list fallback: ${sitesOnlyError?.message || sitesOnlyError}`);
    return [];
  }
}

export async function getCategoryTree(env, { space = '' } = {}) {
  const categories = await listCategories(env, { space });
  const tree = buildTree(categories);
  const existingPrivateNode = removePrivateCategoryNode(tree);

  tree.push({
    ...(existingPrivateNode || {
      id: 'private-bookmarks',
      name: PRIVATE_BOOKMARK_CATEGORY,
      parent_id: null,
      sort_order: 2147483647,
      icon: '',
      description: '',
      site_count: 0,
      child_count: 0,
      children: [],
    }),
    name: PRIVATE_BOOKMARK_CATEGORY,
    parent_id: null,
    sort_order: 2147483647,
    description: existingPrivateNode?.description || '',
    is_private: true,
  });

  return tree;
}

function removePrivateCategoryNode(nodes) {
  const index = nodes.findIndex((node) => node.name === PRIVATE_BOOKMARK_CATEGORY);
  if (index !== -1) {
    return nodes.splice(index, 1)[0];
  }

  for (const node of nodes) {
    const found = removePrivateCategoryNode(node.children || []);
    if (found) return found;
  }

  return null;
}

export async function createCategory(env, body, { ip } = {}) {
  const name = cleanText(body?.name);
  if (!name) throw new Error('Category name is required');

  const parentId = body?.parent_id ? Number(body.parent_id) : null;
  const sortOrder = normalizeSortOrder(body?.sort_order);
  if (parentId) {
    const parent = await env.NAV_DB.prepare('SELECT id FROM categories WHERE id = ?').bind(parentId).first();
    if (!parent) throw new Error('Parent category not found');
  }

  const result = await env.NAV_DB.prepare(`
    INSERT INTO categories (name, parent_id, sort_order, icon, color, description)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(name, parentId, sortOrder, cleanText(body?.icon) || null, cleanCategoryColor(body?.color), cleanText(body?.description) || null).run();

  await env.NAV_DB.prepare(`
    INSERT INTO category_orders (catelog, sort_order)
    VALUES (?, ?)
    ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order
  `).bind(name, sortOrder).run();
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.CATEGORY_CREATE, target: 'category', summary: name, ip });

  return result;
}

export async function updateCategory(env, idOrName, body, { ip } = {}) {
  const category = await findCategory(env, idOrName);
  if (!category) throw new Error('Category not found');

  const newName = cleanText(body?.name, category.name);
  const parentId = body?.parent_id === '' || body?.parent_id === undefined ? category.parent_id : (body.parent_id === null ? null : Number(body.parent_id));
  const sortOrder = normalizeSortOrder(body?.sort_order, normalizeSortOrder(category.sort_order));
  const icon = body?.icon === undefined ? category.icon : (cleanText(body.icon) || null);
  const color = body?.color === undefined ? category.color : cleanCategoryColor(body.color);
  const description = body?.description === undefined ? category.description : (cleanText(body.description) || null);
  if (parentId && Number(parentId) === Number(category.id)) {
    throw new Error('Category cannot be its own parent');
  }
  if (parentId) {
    const parent = await env.NAV_DB.prepare('SELECT id FROM categories WHERE id = ?').bind(parentId).first();
    if (!parent) throw new Error('Parent category not found');
    const descendants = await getDescendantCategoryIds(env, category.id);
    if (descendants.includes(Number(parentId))) {
      throw new Error('Category cannot move into its descendant category');
    }
  }

  await env.NAV_DB.batch([
    env.NAV_DB.prepare(`
      UPDATE categories
      SET name = ?, parent_id = ?, sort_order = ?, icon = ?, color = ?, description = ?, update_time = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(newName, parentId || null, sortOrder, icon, color, description, category.id),
    env.NAV_DB.prepare('UPDATE sites SET catelog = ?, update_time = CURRENT_TIMESTAMP WHERE category_id IS NULL AND catelog = ?').bind(newName, category.name),
    env.NAV_DB.prepare('UPDATE pending_sites SET catelog = ? WHERE catelog = ?').bind(newName, category.name),
    env.NAV_DB.prepare('DELETE FROM category_orders WHERE catelog = ?').bind(category.name),
    env.NAV_DB.prepare(`
      INSERT INTO category_orders (catelog, sort_order)
      VALUES (?, ?)
      ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order
    `).bind(newName, sortOrder),
  ]);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.CATEGORY_UPDATE, target: 'category', targetId: category.id, summary: newName, ip });
  return { oldName: category.name, newName, sort_order: sortOrder, parent_id: parentId || null };
}

export async function deleteCategory(env, idOrName, { ip } = {}) {
  const category = await findCategory(env, idOrName);
  if (!category) throw new Error('Category not found');

  const child = await env.NAV_DB.prepare('SELECT id FROM categories WHERE parent_id = ? LIMIT 1').bind(category.id).first();
  if (child) throw new Error('Category has children, please move or delete children first');

  const site = await env.NAV_DB.prepare('SELECT id FROM sites WHERE category_id = ? OR (category_id IS NULL AND catelog = ?) LIMIT 1').bind(category.id, category.name).first();
  if (site) throw new Error('Category has sites, please move sites before deleting');

  await env.NAV_DB.batch([
    env.NAV_DB.prepare('DELETE FROM categories WHERE id = ?').bind(category.id),
    env.NAV_DB.prepare('DELETE FROM category_orders WHERE catelog = ?').bind(category.name),
    env.NAV_DB.prepare('DELETE FROM category_metadata WHERE catelog = ?').bind(category.name),
  ]);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.CATEGORY_DELETE, target: 'category', targetId: category.id, ip });
}

export async function upsertCategoryByName(env, name, sortOrder = 9999) {
  const normalizedName = cleanText(name);
  if (!normalizedName) return null;

  await env.NAV_DB.batch([
    env.NAV_DB.prepare(`
      INSERT INTO categories (name, sort_order)
      VALUES (?, ?)
      ON CONFLICT(name) DO NOTHING
    `).bind(normalizedName, normalizeSortOrder(sortOrder)),
    env.NAV_DB.prepare(`
      INSERT INTO category_orders (catelog, sort_order)
      VALUES (?, ?)
      ON CONFLICT(catelog) DO NOTHING
    `).bind(normalizedName, normalizeSortOrder(sortOrder)),
  ]);

  return findCategory(env, normalizedName);
}

export async function reorderCategories(env, items, { ip } = {}) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('items must be a non-empty array');
  }

  const ids = items.map((item) => Number(item.id)).filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) throw new Error('No valid category ids provided');

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.NAV_DB.prepare(`SELECT id, name FROM categories WHERE id IN (${placeholders})`).bind(...ids).all();
  const nameMap = new Map((results || []).map((row) => [Number(row.id), row.name]));

  const statements = [];
  for (const [index, item] of items.entries()) {
    const id = Number(item.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const sortOrder = normalizeSortOrder(item.sort_order, (index + 1) * 10);
    statements.push(
      env.NAV_DB.prepare('UPDATE categories SET sort_order = ?, update_time = CURRENT_TIMESTAMP WHERE id = ?').bind(sortOrder, id)
    );
    const name = nameMap.get(id);
    if (name) {
      statements.push(
        env.NAV_DB.prepare(`
          INSERT INTO category_orders (catelog, sort_order)
          VALUES (?, ?)
          ON CONFLICT(catelog) DO UPDATE SET sort_order = excluded.sort_order
        `).bind(name, sortOrder)
      );
    }
  }

  if (statements.length) await env.NAV_DB.batch(statements);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.CATEGORY_REORDER, target: 'category', summary: `重排 ${items.length} 个分类`, ip });
  return { updated: items.length };
}

export async function findCategory(env, idOrName) {
  if (/^\d+$/.test(String(idOrName))) {
    return env.NAV_DB.prepare('SELECT * FROM categories WHERE id = ?').bind(Number(idOrName)).first();
  }
  return env.NAV_DB.prepare('SELECT * FROM categories WHERE name = ?').bind(String(idOrName)).first();
}