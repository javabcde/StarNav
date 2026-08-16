import { buildSessionCookie, createAdminSession, destroyAdminSession, validateAdminSession } from '../services/unlockSessionService.js';
import { clearLoginFailures, getLoginThrottle, registerLoginFailure, verifyAdminCredentials } from '../lib/auth.js';
import { htmlResponse, textResponse } from '../lib/utils.js';
import { getAdminAsset } from '../pages/adminAssets.js';
import { renderLoginPage } from '../pages/admin/login.js';

export async function handleAdminRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname === '/admin/logout') {
    if (request.method !== 'POST') return textResponse('Method Not Allowed', 405);
    const { token } = await validateAdminSession(request, env);
    if (token) await destroyAdminSession(env, token);

    return new Response(null, {
      status: 302,
      headers: {
        Location: '/admin',
        'Set-Cookie': buildSessionCookie('', { maxAge: 0 }),
      },
    });
  }

  if (url.pathname === '/admin') {
    if (request.method === 'POST') {
      // 登录失败限速：按客户端 IP 在 KV 计数，超过阈值后短时锁定，缓解在线爆破。
      // 注意 KV 为最终一致，并发请求可能少量绕过，但足以阻断持续爆破。
      const throttle = await getLoginThrottle(env, request);
      if (throttle.locked) {
        return renderLoginPage('登录尝试过于频繁，请 15 分钟后再试。', { status: 429 });
      }

      const formData = await request.formData();
      const name = (formData.get('name') || '').trim();
      const password = (formData.get('password') || '').trim();

      if (await verifyAdminCredentials(env, name, password)) {
        await clearLoginFailures(env, throttle.key);
        const token = await createAdminSession(env);
        return new Response(null, {
          status: 302,
          headers: {
            Location: '/admin',
            'Set-Cookie': buildSessionCookie(token),
          },
        });
      }

      await registerLoginFailure(env, throttle.key, throttle.count);
      return renderLoginPage('账号或密码错误，请重试。');
    }

    const session = await validateAdminSession(request, env);
    return session.authenticated ? renderAdminPage() : renderLoginPage();
  }

  if (url.pathname.startsWith('/static/')) {
    const filePath = url.pathname.replace('/static/', '');
    const asset = getAdminAsset(filePath);
    if (!asset) return textResponse('Not Found', 404);
    // 可被缓存但每次使用前必须 revalidate（no-cache）：内容变化时 version(ETag) 随之改变，
    // 未变则返回 304 省去 body 传输——既保证永不取到过期内容，又避免 no-store 的每次全量重下。
    const etag = `"${asset.version}"`;
    const cacheControl = 'public, no-cache';
    if (request.headers.get('If-None-Match') === etag) {
      return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': cacheControl } });
    }
    return new Response(asset.content, {
      headers: { 'Content-Type': asset.type, 'Cache-Control': cacheControl, ETag: etag },
    });
  }

  return textResponse('页面不存在', 404);
}

function renderAdminPage() {
  const asset = getAdminAsset('admin.html');
  return htmlResponse(asset.content);
}
