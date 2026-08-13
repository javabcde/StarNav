import test from 'node:test';
import assert from 'node:assert/strict';

import { buildHomeCacheKey } from '../src/lib/edgeCache.js';
import {
  buildClearSiteLockAccessCookie,
  buildSiteLockAccessCookie,
  clearSiteLockPassword,
  createSiteLockAccess,
  getSiteLockThrottle,
  hasSiteLockAccess,
  isSiteLockEnabled,
  registerSiteLockFailure,
  revokeCurrentSiteLockAccess,
  updateSiteLockPassword,
  verifySiteLockPassword,
} from '../src/services/siteLockService.js';

/**
 * 内存版 env mock：NAV_DB.settings（key-value）+ NAV_AUTH.kv（key-value，带 TTL 元数据）。
 */
function createMockEnv() {
  const settings = new Map();
  const kv = new Map();
  const navDb = {
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async first() {
              if (sql.includes('SELECT value FROM settings WHERE key = ?')) {
                const value = settings.get(String(binds[0]));
                return value === undefined ? null : { value };
              }
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO settings')) {
                settings.set(String(binds[0]), String(binds[1]));
              } else if (sql.includes('DELETE FROM settings')) {
                settings.delete(String(binds[0]));
              }
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  const navAuth = {
    async get(key) {
      const entry = kv.get(key);
      return entry ? entry.value : null;
    },
    async put(key, value, opts) {
      kv.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
    async delete(key) {
      kv.delete(key);
    },
    async list({ prefix }) {
      const keys = [...kv.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k }));
      return { keys, list_complete: true };
    },
  };
  return { env: { NAV_DB: navDb, NAV_AUTH: navAuth }, settings, kv };
}

function req(url = 'https://x/', { cookie = '', ip = '1.2.3.4' } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (ip) headers['CF-Connecting-IP'] = ip;
  return new Request(url, { headers });
}

test('默认关闭：未配置密码时整站锁不生效', async () => {
  const { env } = createMockEnv();
  assert.equal(await isSiteLockEnabled(env), false);
});

test('设置密码即启用；少于 4 位被拒绝', async () => {
  const { env } = createMockEnv();
  await assert.rejects(() => updateSiteLockPassword(env, '123'), /at least 4 characters/);
  assert.equal(await isSiteLockEnabled(env), false);

  await updateSiteLockPassword(env, 's3cret');
  assert.equal(await isSiteLockEnabled(env), true);
});

test('verifySiteLockPassword 校验正确/错误密码，不清空即不泄漏明文', async () => {
  const { env, settings } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');
  assert.equal(await verifySiteLockPassword(env, 's3cret'), true);
  assert.equal(await verifySiteLockPassword(env, 'wrong'), false);
  const stored = settings.get('site_lock_password');
  assert.ok(stored.startsWith('pbkdf2$'), '存储的必须是 PBKDF2 哈希');
  assert.ok(!stored.includes('s3cret'), '明文不得出现在存储中');
});

test('清除密码即关闭，并撤销全部解锁会话', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');
  const { token } = await createSiteLockAccess(env, { duration: '1h' });
  assert.equal(await hasSiteLockAccess(req('https://x/', { cookie: `nav_site_lock=${token}` }), env), true);

  await clearSiteLockPassword(env);
  assert.equal(await isSiteLockEnabled(env), false);
  assert.equal(await hasSiteLockAccess(req('https://x/', { cookie: `nav_site_lock=${token}` }), env), false);
});

test('修改密码使已发解锁会话失效', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 'old-pass');
  const { token } = await createSiteLockAccess(env, { duration: '12h' });
  assert.equal(await hasSiteLockAccess(req('https://x/', { cookie: `nav_site_lock=${token}` }), env), true);

  await updateSiteLockPassword(env, 'new-pass');
  assert.equal(await hasSiteLockAccess(req('https://x/', { cookie: `nav_site_lock=${token}` }), env), false);
});

test('解锁会话：有效 token 通过，未知 token 拒绝，退出后失效', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  assert.equal(await hasSiteLockAccess(req('https://x/'), env), false, '无 cookie 未解锁');
  assert.equal(await hasSiteLockAccess(req('https://x/', { cookie: 'nav_site_lock=unknown-token' }), env), false);

  const { token } = await createSiteLockAccess(env, { duration: '7d' });
  const unlockedReq = req('https://x/', { cookie: `nav_site_lock=${token}` });
  assert.equal(await hasSiteLockAccess(unlockedReq, env), true);

  await revokeCurrentSiteLockAccess(unlockedReq, env);
  assert.equal(await hasSiteLockAccess(unlockedReq, env), false);
});

test('解锁 Cookie 构建：session 不带 Max-Age，其余带 TTL', () => {
  const sessionCookie = buildSiteLockAccessCookie('tok', { duration: 'session' });
  assert.ok(sessionCookie.includes('nav_site_lock=tok'));
  assert.ok(!sessionCookie.includes('Max-Age'));

  const ttlCookie = buildSiteLockAccessCookie('tok', { duration: '1h', maxAge: 3600 });
  assert.ok(ttlCookie.includes('Max-Age=3600'));

  const clearCookie = buildClearSiteLockAccessCookie();
  assert.ok(clearCookie.includes('nav_site_lock='));
  assert.ok(clearCookie.includes('Max-Age=0'));
});

test('试错限速：5 次失败后锁定，计数独立于后台登录 key', async () => {
  const { env } = createMockEnv();
  for (let i = 0; i < 5; i += 1) {
    const throttle = await getSiteLockThrottle(env, req('https://x/'));
    assert.equal(throttle.locked, false, `第 ${i + 1} 次尝试前不应锁定`);
    await registerSiteLockFailure(env, throttle.key, throttle.count);
  }
  const locked = await getSiteLockThrottle(env, req('https://x/'));
  assert.equal(locked.locked, true, '第 5 次失败后应锁定');
  assert.ok(locked.key.startsWith('site-lock:throttle:'), '使用独立 key 前缀');
  assert.ok(!locked.key.startsWith('login_fail:'), '不得与后台登录共享计数');
});

test('nav_site_lock cookie 属于鉴权 cookie：首页不进共享缓存', () => {
  assert.equal(buildHomeCacheKey(req('https://x/', { cookie: 'nav_site_lock=tok' })), null);
  // 与无关 cookie 混杂时也要识别出鉴权 cookie
  assert.equal(buildHomeCacheKey(req('https://x/', { cookie: 'foo=1; nav_site_lock=tok; bar=2' })), null);
  // 锁禁用时的匿名首页仍可缓存
  assert.ok(buildHomeCacheKey(req('https://x/')), '纯匿名首页仍应可缓存');
});

// ── handler 级冒烟：路由拦截、302/403、解锁回跳、管理员/Token 旁路 ──

import { handleSiteLockRequest, isSiteLockAllowlisted } from '../src/handlers/siteLock.js';
import { createAdminSession, createApiToken } from '../src/lib/auth.js';

test('锁未启用时 handler 放行所有请求', async () => {
  const { env } = createMockEnv();
  assert.equal(await handleSiteLockRequest(req('https://x/'), env), null);
  assert.equal(await handleSiteLockRequest(req('https://x/api/config'), env), null);
  assert.equal(await handleSiteLockRequest(req('https://x/go/1'), env), null);
});

test('启用后匿名页面请求：/ 渲染锁页，其余 302 到锁页并携带同源回跳', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  const home = await handleSiteLockRequest(req('https://x/'), env);
  assert.equal(home.status, 200);
  assert.ok((await home.text()).includes('name="password"'), '应渲染锁页表单');

  const homeWithNext = await handleSiteLockRequest(req('https://x/?next=%2Fgo%2F1'), env);
  assert.equal(homeWithNext.status, 200);
  assert.ok((await homeWithNext.text()).includes('value="/go/1"'), '锁页应保留同源回跳地址');

  const go = await handleSiteLockRequest(req('https://x/go/123?x=1'), env);
  assert.equal(go.status, 302);
  assert.equal(go.headers.get('Location'), '/?next=%2Fgo%2F123%3Fx%3D1');
});

test('启用后匿名 API 返回 403；有效 Bearer Token 放行', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  const blocked = await handleSiteLockRequest(req('https://x/api/config'), env);
  assert.equal(blocked.status, 403);

  const { token } = await createApiToken(env, { name: 'test', scopes: ['read'] });
  const headers = { Authorization: `Bearer ${token}` };
  const withToken = await handleSiteLockRequest(new Request('https://x/api/config', { headers }), env);
  assert.equal(withToken, null, '有效 Token 应放行');

  const withFakeToken = await handleSiteLockRequest(new Request('https://x/api/config', { headers: { Authorization: 'Bearer fake' } }), env);
  assert.equal(withFakeToken.status, 403, '伪造 Token 不得放行');
});

test('管理员会话免锁；白名单路由免锁', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  const adminToken = await createAdminSession(env);
  const adminReq = req('https://x/', { cookie: `nav_admin_session=${adminToken}` });
  assert.equal(await handleSiteLockRequest(adminReq, env), null, '管理员应免锁');

  assert.equal(await handleSiteLockRequest(req('https://x/admin'), env), null, '登录页放行');
  assert.equal(await handleSiteLockRequest(req('https://x/admin', { method: 'POST' }), env), null, '登录 POST 放行');
  assert.equal(await handleSiteLockRequest(req('https://x/static/admin.css'), env), null, '后台静态资源放行');
  assert.equal(await handleSiteLockRequest(req('https://x/api/settings/public'), env), null, '品牌接口放行');
  assert.equal(isSiteLockAllowlisted('/admin', 'GET'), true);
  assert.equal(isSiteLockAllowlisted('/admin/logout', 'POST'), false);
  assert.equal(isSiteLockAllowlisted('/api/config', 'GET'), false);
});

test('锁页 POST：错误密码重渲锁页，正确密码 302 + 种解锁 Cookie', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  const wrongBody = new FormData();
  wrongBody.append('password', 'wrong');
  wrongBody.append('duration', '12h');
  const wrong = await handleSiteLockRequest(new Request('https://x/?next=%2Fgo%2F1', { method: 'POST', body: wrongBody }), env);
  assert.equal(wrong.status, 200);
  assert.ok((await wrong.text()).includes('访问密码错误'), '应显示密码错误提示');

  const rightBody = new FormData();
  rightBody.append('password', 's3cret');
  rightBody.append('duration', '12h');
  const right = await handleSiteLockRequest(new Request('https://x/?next=%2Fgo%2F1', { method: 'POST', body: rightBody }), env);
  assert.equal(right.status, 200);
  assert.ok(right.headers.get('Set-Cookie').includes('nav_site_lock='), '应种解锁 Cookie');
  assert.ok((await right.text()).includes('location.replace("/go/1")'), '桥页应跳转同源 next');
});

test('锁页 POST：外部回跳地址被拒绝，回首页', async () => {
  const { env } = createMockEnv();
  await updateSiteLockPassword(env, 's3cret');

  const body = new FormData();
  body.append('password', 's3cret');
  body.append('next', 'https://evil.example/phish');
  const response = await handleSiteLockRequest(new Request('https://x/', { method: 'POST', body }), env);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('location.replace("/")'), '外部地址应回首页');
});

test('解锁 Cookie 兼容移动浏览器：保留 HttpOnly/SameSite=Strict，不带 Secure', () => {
  const cookie = buildSiteLockAccessCookie('tok', { maxAge: 3600, duration: '1h' });
  assert.ok(cookie.includes('HttpOnly'), '应保留 HttpOnly');
  assert.ok(cookie.includes('SameSite=Strict'), '应保留 SameSite=Strict');
  assert.ok(!cookie.includes('Secure'), 'Secure 会被夸克/VIA 丢弃导致解锁失败（探针实测，站点 https-only 无实际损失）');
});
