import { isAdminAuthenticated, validateApiToken } from '../lib/auth.js';
import { resolveI18n } from '../lib/i18n.js';
import { errorResponse } from '../lib/utils.js';
import { renderSiteLockPage } from '../pages/home/siteLock.js';
import {
  buildSiteLockAccessCookie,
  clearSiteLockFailures,
  createSiteLockAccess,
  getSiteLockThrottle,
  hasSiteLockAccess,
  isSiteLockEnabled,
  registerSiteLockFailure,
  verifySiteLockPassword,
} from '../services/siteLockService.js';

/**
 * 整站锁白名单：这些路由在锁启用时仍可匿名访问。
 * PWA 静态资源无需在此列出——handlePwaRequest 在 routeRequest 中先于本 handler 执行。
 *
 * @param {string} path URL pathname。
 * @param {string} method HTTP 方法。
 * @returns {boolean} 是否白名单路由。
 */
export function isSiteLockAllowlisted(path, method) {
  if (path === '/admin' && (method === 'GET' || method === 'POST')) return true;
  if (path.startsWith('/static/')) return true;
  if (path === '/api/settings/public' && method === 'GET') return true;
  return false;
}

/**
 * 整站锁请求拦截。返回：
 * - null：锁未启用 / 请求已解锁 / 白名单路由 → 继续正常路由。
 * - Response：锁页 / 302 跳锁页 / API 403。
 */
export async function handleSiteLockRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (isSiteLockAllowlisted(path, request.method)) return null;
  if (!(await isSiteLockEnabled(env))) return null;
  if (await isAdminAuthenticated(request, env)) return null;
  if (await hasSiteLockAccess(request, env)) return null;

  // 锁页表单提交（POST /）。
  if (path === '/' && request.method === 'POST') {
    return handleSiteLockUnlock(request, env, url);
  }

  // API：匿名 403；有效 Bearer Token 放行（具体 scope 仍由各路由自行校验）。
  if (path.startsWith('/api')) {
    const tokenAuth = await validateApiToken(request, env, '');
    if (tokenAuth.authenticated) return null;
    return errorResponse('Site is locked', 403);
  }

  // 页面：锁页位于 /，携带同源回跳地址；访问 / 直接渲染锁页（避免 302 环）。
  if (path === '/') {
    const i18n = resolveI18n(request);
    return renderSiteLockPage({ next: url.searchParams.get('next') || '', i18n });
  }
  const next = `${path}${url.search}`;
  return new Response(null, {
    status: 302,
    headers: { Location: `/?next=${encodeURIComponent(next)}` },
  });
}

/**
 * 处理锁页密码提交：限速检查 → 密码验证 → 种解锁 Cookie → 同源回跳。
 */
async function handleSiteLockUnlock(request, env, url) {
  const i18n = resolveI18n(request);
  const formNext = String(url.searchParams.get('next') || '');

  const throttle = await getSiteLockThrottle(env, request);
  if (throttle.locked) {
    return renderSiteLockPage({ next: formNext, error: i18n.t('siteLockLocked'), i18n });
  }

  const formData = await request.formData();
  const password = String(formData.get('password') || '');
  const duration = String(formData.get('duration') || '12h');
  const next = normalizeNext(formData.get('next') || formNext);

  if (await verifySiteLockPassword(env, password)) {
    await clearSiteLockFailures(env, throttle.key);
    const { token, ttl, duration: normalizedDuration } = await createSiteLockAccess(env, { duration });
    return new Response(null, {
      status: 302,
      headers: {
        Location: next,
        'Set-Cookie': buildSiteLockAccessCookie(token, { maxAge: ttl, duration: normalizedDuration }),
      },
    });
  }

  await registerSiteLockFailure(env, throttle.key, throttle.count);
  return renderSiteLockPage({ next, error: i18n.t('siteLockError'), i18n });
}

/**
 * 回跳地址规范化：仅接受同源路径（以单个 / 开头），否则回首页。
 * 同时剔除控制字符，防止污染 Location 头。
 */
function normalizeNext(value) {
  const raw = String(value || '').trim().replace(/[\r\n\t]/g, '');
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/';
}
