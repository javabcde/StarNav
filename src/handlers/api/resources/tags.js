// 标签资源模块（tags）：公开读（list），管理写（suggest/apply/merge 系列）。
import { jsonResponse } from '../../../lib/utils.js';
import { clientIpFromRequest } from '../../../services/operationLogService.js';
import { requireAdmin } from '../errors.js';
import { applySiteTagSuggestions, listSitesNeedingTags, listTags, mergeTags } from '../../../services/tagService.js';
import { suggestTagMerges, suggestTagsForSite, suggestTagsForSites } from '../../../services/aiService.js';

/** GET /tags — 公开标签列表。 */
export async function list(request, env, ctx, path, method, id, url) {
  const data = await listTags(env);
  return jsonResponse({ code: 200, data });
}

/** GET /tags/needs-review — 待打标站点（管理员）。 */
export async function needsReview(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await listSitesNeedingTags(env, {
    limit: url.searchParams.get('limit') || 20,
    maxTags: url.searchParams.get('maxTags') || 0,
  });
  return jsonResponse({ code: 200, data, total: data.length });
}

/** POST /tags/suggest — 单站标签建议（管理员）。 */
export async function suggest(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const siteInput = body?.siteId || body?.id || {
    name: body?.name,
    url: body?.url,
    desc: body?.desc,
    catelog: body?.catelog,
    tags: body?.tags,
  };
  const data = await suggestTagsForSite(env, siteInput, { limit: body?.limit });
  return jsonResponse({ code: 200, message: 'Tags suggested successfully', data });
}

/** POST /tags/suggest-batch — 批量标签建议（管理员）。 */
export async function suggestBatch(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const data = await suggestTagsForSites(env, body?.siteIds || body?.ids || [], {
    limit: body?.limit,
    batchLimit: body?.batchLimit,
  });
  return jsonResponse({ code: 200, message: 'Batch tags suggested successfully', data });
}

/** POST /tags/apply-suggestions — 应用标签建议（管理员；记录在服务层）。 */
export async function applySuggestions(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const data = await applySiteTagSuggestions(env, body, { ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 200, message: 'Tag suggestions applied successfully', data });
}

/** POST /tags/merge-suggestions — 生成合并建议（管理员）。 */
export async function mergeSuggestions(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const data = await suggestTagMerges(env, { limit: body?.limit });
  return jsonResponse({ code: 200, message: 'Tag merge suggestions generated successfully', data });
}

/** POST /tags/merge — 合并标签（管理员；记录在服务层）。 */
export async function merge(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const data = await mergeTags(env, body, { ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 200, message: 'Tags merged successfully', data });
}
