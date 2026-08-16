// 管理员会话管理器（unlockSessionService.createAdminSessionManager）单测
// （2026-08-16 架构评审候选 5）：KV token 生命周期、滑动续期节流、绝对过期销毁、
// 请求级 WeakMap 缓存；lib/auth.js 的 re-export 垫片同一性一并锁定。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  createAdminSession,
  createAdminSessionManager,
  destroyAdminSession,
  isAdminAuthenticated,
  refreshAdminSession,
  validateAdminSession,
} from '../src/services/unlockSessionService.js';
import * as auth from '../src/lib/auth.js';

function createMemoryKv() {
  const map = new Map();
  const reads = { count: 0 };
  return {
    get: async (k) => { reads.count += 1; return map.get(k) ?? null; },
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => { map.delete(k); },
    _map: map,
    _reads: reads,
  };
}

function createRequest(cookieHeader = '') {
  return new Request('https://nav.example.com/', { headers: cookieHeader ? { Cookie: cookieHeader } : {} });
}

const TTL = 60 * 60 * 12;
const ABSOLUTE = 60 * 60 * 24 * 7;

test('createSession：写入 {createdAt} payload 并返回 token', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });

  assert.ok(token);
  const payload = JSON.parse(kv._map.get(`session-test:${token}`));
  assert.ok(Number.isFinite(payload.createdAt));
});

test('validateSession：无 cookie / 无效 token 拒绝，有效 token 通过', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });

  assert.equal((await manager.validateSession(createRequest(), { NAV_AUTH: kv })).authenticated, false);
  assert.equal((await manager.validateSession(createRequest(`nav_admin_session=bogus`), { NAV_AUTH: kv })).authenticated, false);
  const ok = await manager.validateSession(createRequest(`nav_admin_session=${token}`), { NAV_AUTH: kv });
  assert.equal(ok.authenticated, true);
  assert.equal(ok.token, token);
});

test('滑动续期：半窗内不写 KV，过半窗补 lastRefresh', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });
  const key = `session-test:${token}`;
  const now = Date.now();

  // 刚创建：半窗内 → 不续期
  await manager.validateSession(createRequest(`nav_admin_session=${token}`), { NAV_AUTH: kv });
  assert.ok(!JSON.parse(kv._map.get(key)).lastRefresh, '半窗内不应写 lastRefresh');

  // 手工把 lastRefresh 推过半个窗口 → 续期并写 lastRefresh
  kv._map.set(key, JSON.stringify({ createdAt: now - TTL * 1000 * 0.9, lastRefresh: now - TTL * 1000 * 0.6 }));
  await manager.validateSession(createRequest(`nav_admin_session=${token}`), { NAV_AUTH: kv });
  const renewed = JSON.parse(kv._map.get(key));
  assert.ok(renewed.lastRefresh > now - TTL * 1000 * 0.6, '过半窗应写新 lastRefresh');
});

test('绝对过期：超 7 天销毁会话并拒绝', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });
  const key = `session-test:${token}`;

  kv._map.set(key, JSON.stringify({ createdAt: Date.now() - ABSOLUTE * 1000 - 1000 }));
  const result = await manager.validateSession(createRequest(`nav_admin_session=${token}`), { NAV_AUTH: kv });
  assert.equal(result.authenticated, false);
  assert.equal(kv._map.has(key), false, '绝对过期应销毁 KV 会话');
});

test('destroySession：清除 KV 会话；空 token 幂等', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });

  await manager.destroySession({ NAV_AUTH: kv }, token);
  assert.equal(kv._map.has(`session-test:${token}`), false);
  await manager.destroySession({ NAV_AUTH: kv }, '');
});

test('isAuthenticated：同请求 WeakMap 缓存只读一次 KV', async () => {
  const kv = createMemoryKv();
  const manager = createAdminSessionManager({ tokenPrefix: 'session-test:' });
  const token = await manager.createSession({ NAV_AUTH: kv });
  const request = createRequest(`nav_admin_session=${token}`);

  const [a, b, c] = await Promise.all([
    manager.isAuthenticated(request, { NAV_AUTH: kv }),
    manager.isAuthenticated(request, { NAV_AUTH: kv }),
    manager.isAuthenticated(request, { NAV_AUTH: kv }),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(c, true);
  assert.equal(kv._reads.count, 1, '同请求多次调用应只读一次 KV');
});

test('垫片同一性：lib/auth.js re-export 与 unlockSessionService 单例同引用', () => {
  assert.equal(SESSION_COOKIE_NAME, 'nav_admin_session');
  assert.equal(auth.SESSION_COOKIE_NAME, SESSION_COOKIE_NAME);
  assert.equal(auth.buildSessionCookie, buildSessionCookie);
  assert.equal(auth.createAdminSession, createAdminSession);
  assert.equal(auth.refreshAdminSession, refreshAdminSession);
  assert.equal(auth.destroyAdminSession, destroyAdminSession);
  assert.equal(auth.validateAdminSession, validateAdminSession);
  assert.equal(auth.isAdminAuthenticated, isAdminAuthenticated);
});

test('buildSessionCookie：属性集来自 sessionPolicy（HttpOnly/Path/无 Secure）', () => {
  const cookie = buildSessionCookie('tok');
  assert.ok(cookie.includes('nav_admin_session=tok'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Path=/'));
  assert.ok(!cookie.includes('Secure'));
});
