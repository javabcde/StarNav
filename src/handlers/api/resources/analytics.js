// 统计资源模块（analytics）：搜索/站点/投稿三类统计（管理员）。
import { jsonResponse } from '../../../lib/utils.js';
import { requireAdmin } from '../errors.js';
import { getSearchAnalytics, getSiteAnalytics } from '../../../services/siteService.js';
import { getSubmissionAnalytics } from '../../../services/submissionService.js';

/** GET /analytics/search — 搜索词统计（管理员）。 */
export async function search(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await getSearchAnalytics(env, { limit: url.searchParams.get('limit') || 20 });
  return jsonResponse({ code: 200, data });
}

/** GET /analytics/sites — 站点访问统计（管理员，admin 访问上下文）。 */
export async function sites(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await getSiteAnalytics(env, { limit: url.searchParams.get('limit') || 20, access: { adminAuthed: true } });
  return jsonResponse({ code: 200, data });
}

/** GET /analytics/submissions — 投稿统计（管理员）。 */
export async function submissions(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await getSubmissionAnalytics(env, { days: url.searchParams.get('days') || 30 });
  return jsonResponse({ code: 200, data });
}
