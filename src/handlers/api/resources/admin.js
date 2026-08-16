// 管理资源模块（admin）：健康检查、token、webhook、操作日志（管理员）。
import { jsonResponse } from '../../../lib/utils.js';
import { createApiToken, listApiTokens, revokeApiToken } from '../../../lib/apiTokenService.js';
import { listOperationLogs } from '../../../services/operationLogService.js';
import { getSystemHealth } from '../../../services/systemHealthService.js';
import { createWebhook, deleteWebhook, listWebhooks, testWebhook, updateWebhook } from '../../../services/webhookService.js';
import { requireAdmin } from '../errors.js';

/** GET /system/health — 系统健康概览（管理员）。 */
export async function systemHealth(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  return jsonResponse({ code: 200, data: await getSystemHealth(env) });
}

/** GET /tokens — API token 列表（管理员）。 */
export async function listTokens(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const data = await listApiTokens(env);
  return jsonResponse({ code: 200, data, total: data.length });
}

/** POST /tokens — 创建 API token（管理员）。 */
export async function createToken(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const result = await createApiToken(env, body);
  return jsonResponse({ code: 201, message: 'API token created successfully', ...result }, 201);
}

/** /tokens/:id — DELETE 吊销（管理员；非 DELETE 方法不进门槛，与旧行为一致）。 */
export async function tokensItem(request, env, ctx, path, method, id, url) {
  if (path === '/tokens') return null; // 集合路径非 GET/POST 不进门禁（与旧 404 行为一致）
  if (method !== 'DELETE') return null;
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const tokenId = decodeURIComponent(path.split('/')[2] || '');
  const data = await revokeApiToken(env, tokenId);
  return jsonResponse({ code: 200, message: 'API token revoked successfully', data });
}

export async function webhooksList(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const data = await listWebhooks(env);
  return jsonResponse({ code: 200, data, total: data.length });
}

export async function webhooksCreate(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const data = await createWebhook(env, await request.json().catch(() => ({})));
  return jsonResponse({ code: 201, message: 'Webhook created successfully', data }, 201);
}

/** /webhooks/:id — POST test / PUT / DELETE（管理员；任意方法先进门禁，与旧行为一致）。 */
export async function webhooksItem(request, env, ctx, path, method, id, url) {
  if (path === '/webhooks') return null; // 集合路径非 GET/POST 不进门禁（与旧 404 行为一致）
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;
  const webhookId = decodeURIComponent(path.split('/')[2] || '');

  if (path.endsWith('/test') && method === 'POST') {
    const data = await testWebhook(env, webhookId);
    return jsonResponse({ code: 200, message: 'Webhook test completed', data });
  }

  if (method === 'PUT') {
    const data = await updateWebhook(env, webhookId, await request.json().catch(() => ({})));
    return jsonResponse({ code: 200, message: 'Webhook updated successfully', data });
  }

  if (method === 'DELETE') {
    await deleteWebhook(env, webhookId);
    return jsonResponse({ code: 200, message: 'Webhook deleted successfully' });
  }

  return null;
}

/** GET /operation-logs — 操作日志列表（管理员）。 */
export async function operationLogs(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await listOperationLogs(env, {
    page: url.searchParams.get('page') || 1,
    pageSize: url.searchParams.get('pageSize') || 20,
    action: url.searchParams.get('action') || '',
    target: url.searchParams.get('target') || '',
  });
  return jsonResponse({ code: 200, ...data });
}
