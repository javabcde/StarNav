import { conflict, errorResponse, forbidden, isSubmissionEnabled, jsonResponse, unauthorized } from '../../lib/utils.js';
import { hasBearerToken, isAdminAuthenticated, tokenHasScope, validateApiToken } from '../../lib/auth.js';
import { getAccessContext } from '../../services/accessService.js';
import { getSystemSettings } from '../../services/systemSettingsService.js';

export async function requireAdmin(request, env, options = {}) {
  const { allowApiToken = false, scope = 'write' } = options;
  const access = await getAccessContext(request, env);

  // 弱 token + admin cookie → 403 的既有优先级保持：token 存在但 scope 不足时
  // 先于 admin 会话判定短路（与迁移前 validateApiToken 行为一致）。
  if (allowApiToken && hasBearerToken(request)) {
    if (access.tokenAuthenticated) {
      if (tokenHasScope(access.tokenScopes, scope)) return null;
      return forbidden('API token scope is insufficient', {
        requiredScope: scope,
        tokenScopes: access.tokenScopes,
      });
    }
  }

  if (access.adminAuthed) return null;

  return unauthorized(allowApiToken ? 'Admin cookie or Bearer token is required' : 'Admin authentication is required', {
    allowApiToken,
    requiredScope: allowApiToken ? scope : undefined,
  });
}

/**
 * 公开投稿鉴权（管理员 cookie / write token / 投稿开关三段合一）：
 * /site/preview 与 /submit/suggest-* 共用，替代三份逐字复制的内联判定。
 * 返回 null 表示通过，否则为错误响应。
 */
export async function requireSubmitter(request, env) {
  const adminAuthed = await isAdminAuthenticated(request, env);
  const tokenAuth = adminAuthed ? { authenticated: true } : await validateApiToken(request, env, 'write');
  if (!adminAuthed && !tokenAuth.authenticated) {
    const settings = await getSystemSettings(env);
    if (!isSubmissionEnabled(env, settings)) return errorResponse('Public submission disabled', 403);
  }
  if (tokenAuth.forbidden) return errorResponse('API token scope is insufficient', 403);
  return null;
}

export async function handleApiError(error) {
  if (error?.code === 'DUPLICATE_URL') {
    const details = {
      duplicate: error.duplicate || null,
      scope: error.scope || 'site',
    };
    const response = conflict(error.message, details);
    const payload = await response.json();
    return jsonResponse({ ...payload, ...details }, 409);
  }

  // 请求体 JSON 解析失败（SyntaxError）属客户端错误，统一归 400，避免畸形/空请求体被当成 500。
  if (error instanceof SyntaxError) {
    return errorResponse('Invalid JSON in request body', 400);
  }

  const message = error?.message || 'Internal Server Error';
  const explicitStatus = Number(error?.statusCode || error?.status);
  const status = Number.isInteger(explicitStatus) && explicitStatus >= 400 && explicitStatus < 600
    ? explicitStatus
    : /required|invalid|not found|children|sites|parent|must be|valid https url/i.test(message)
      ? 400
      : 500;

  if (status >= 500) {
    // 5xx 不向客户端回显内部错误细节，仅记录日志便于排查
    console.log(`[api] internal error: ${error?.stack || message}`);
    return errorResponse('Internal Server Error', status);
  }
  return errorResponse(message, status);
}