// AI 资源模块（ai）：聊天（公开，访问上下文）与管理分析（管理员）。
import { errorResponse, jsonResponse } from '../../../lib/utils.js';
import { getAccessContext } from '../../../services/accessService.js';
import { requireAdmin } from '../errors.js';
import { analyzeCategoryErrors, analyzeDuplicateSites, analyzeNoTagSites, analyzeSearchGaps, chatWithAiAssistant } from '../../../services/aiService.js';

/** POST /ai/chat — AI 聊天（公开，访问上下文过滤站点可见性）。 */
export async function chat(request, env, ctx, path, method, id, url) {
  const body = await request.json();
  const access = await getAccessContext(request, env);
  const result = await chatWithAiAssistant(env, {
    message: body?.message,
    previousSites: body?.previousSites || body?.contextSites || [],
    access,
  });
  return jsonResponse(result);
}

/** POST /ai/admin/analyze — 管理分析（no-tags / duplicates / search-gaps / category-errors，管理员）。 */
export async function adminAnalyze(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const type = body?.type || '';
  const limit = body?.limit || 20;
  let data;
  switch (type) {
    case 'no-tags': data = await analyzeNoTagSites(env, { limit }); break;
    case 'duplicates': data = await analyzeDuplicateSites(env, { limit }); break;
    case 'search-gaps': data = await analyzeSearchGaps(env, { limit }); break;
    case 'category-errors': data = await analyzeCategoryErrors(env, { limit }); break;
    default: return errorResponse('Invalid analysis type. Use: no-tags, duplicates, search-gaps, category-errors', 400);
  }
  return jsonResponse({ code: 200, data });
}
