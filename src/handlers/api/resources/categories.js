// 分类资源模块（categories）：公开读（list/tree），管理写（create/update/delete/reorder/suggest）。
import { jsonResponse } from '../../../lib/utils.js';
import { clientIpFromRequest } from '../../../services/operationLogService.js';
import { suggestCategoryForSite } from '../../../services/aiService.js';
import { requireAdmin } from '../errors.js';
import { createCategory, deleteCategory, getCategoryTree, listCategories, reorderCategories, updateCategory } from '../../../services/categoryService.js';

/** GET /categories — 公开分类列表。 */
export async function list(request, env, ctx, path, method, id, url) {
  const data = await listCategories(env);
  return jsonResponse({ code: 200, data });
}

/** GET /categories/tree — 公开分类树。 */
export async function tree(request, env, ctx, path, method, id, url) {
  const data = await getCategoryTree(env);
  return jsonResponse({ code: 200, data });
}

/** POST /categories — 创建分类（管理员；记录在服务层）。 */
export async function create(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const insert = await createCategory(env, body, { ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 201, message: 'Category created successfully', insert }, 201);
}

/** POST /categories/suggest — AI 分类建议（管理员）。 */
export async function suggest(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await suggestCategoryForSite(env, await request.json());
  return jsonResponse({ code: 200, message: 'Category suggested successfully', data });
}

/** POST /categories/reorder — 分类排序（管理员；记录在服务层）。 */
export async function reorder(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const result = await reorderCategories(env, body.items || body, { ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 200, message: 'Categories reordered successfully', result });
}

/** /categories/:id — PUT 更新 / DELETE 删除（管理员；记录在服务层）。 */
export async function item(request, env, ctx, path, method, id, url) {
  if (path === '/categories') return null; // 集合路径未知方法不进门禁（与旧 404 行为一致）
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const decodedId = decodeURIComponent(id);

  if (method === 'PUT') {
    const body = await request.json();
    if (body?.reset) {
      body.sort_order = 9999;
    }
    const result = await updateCategory(env, decodedId, body, { ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Category updated successfully', data: result });
  }

  if (method === 'DELETE') {
    await deleteCategory(env, decodedId, { ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Category deleted successfully' });
  }

  return null;
}
