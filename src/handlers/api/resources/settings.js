// 设置资源模块（settings）：公开设置（public）、系统/AI/私人书签/整站锁设置（管理员）。
import { jsonResponse } from '../../../lib/utils.js';
import { requireAdmin } from '../errors.js';
import { getAiSettings, updateAiSettings } from '../../../services/aiSettingsService.js';
import { listAiModels, testAiSettings } from '../../../services/aiService.js';
import { getSystemSettings, updateSystemSettings } from '../../../services/systemSettingsService.js';
import { getPrivateBookmarkPassword, updatePrivateBookmarkPassword } from '../../../services/privateBookmarkService.js';
import { clearSiteLockPassword, isSiteLockEnabled, updateSiteLockPassword } from '../../../services/siteLockService.js';

/** GET /settings/public — 公开设置（整站锁白名单路由）。 */
export async function publicGet(request, env, ctx, path, method, id, url) {
  return jsonResponse({ code: 200, data: await getSystemSettings(env) });
}

/** GET /settings/system — 系统设置（管理员）。 */
export async function systemGet(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  return jsonResponse({ code: 200, data: await getSystemSettings(env) });
}

/** PUT /settings/system — 更新系统设置（管理员）。 */
export async function systemPut(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await updateSystemSettings(env, await request.json());
  return jsonResponse({ code: 200, message: 'System settings updated successfully', data });
}

/** GET /settings/ai — AI 设置（管理员）。 */
export async function aiGet(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  return jsonResponse({ code: 200, data: await getAiSettings(env) });
}

/** PUT /settings/ai — 更新 AI 设置（管理员）。 */
export async function aiPut(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await updateAiSettings(env, await request.json());
  return jsonResponse({ code: 200, message: 'AI settings updated successfully', data });
}

/** POST /settings/ai/test — 测试 AI 连接（管理员）。 */
export async function aiTest(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await testAiSettings(env, await request.json());
  return jsonResponse({ code: 200, message: 'AI connection test succeeded', data });
}

/** POST /settings/ai/models — 拉取模型列表（管理员）。 */
export async function aiModels(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await listAiModels(env, await request.json());
  return jsonResponse({ code: 200, message: 'AI models fetched successfully', data });
}

/** GET /settings/private-bookmarks — 私人书签密码配置状态（管理员）。 */
export async function privateGet(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const password = await getPrivateBookmarkPassword(env);
  return jsonResponse({ code: 200, data: { category: '私人书签', passwordConfigured: Boolean(password) } });
}

/** PUT /settings/private-bookmarks — 设置私人书签密码（管理员）。 */
export async function privatePut(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  await updatePrivateBookmarkPassword(env, body?.password);
  return jsonResponse({ code: 200, message: 'Private bookmark password updated successfully' });
}

/** GET /settings/site-lock — 整站锁状态（管理员）。 */
export async function lockGet(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  return jsonResponse({ code: 200, data: { enabled: await isSiteLockEnabled(env) } });
}

/** PUT /settings/site-lock — 设置整站锁密码（管理员）。 */
export async function lockPut(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  await updateSiteLockPassword(env, body?.password);
  return jsonResponse({ code: 200, message: 'Site lock password updated successfully' });
}

/** DELETE /settings/site-lock — 关闭整站锁（管理员）。 */
export async function lockDelete(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  await clearSiteLockPassword(env);
  return jsonResponse({ code: 200, message: 'Site lock disabled successfully' });
}
