import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createAdminSession,
  isAdminAuthenticated,
  validateAdminSession,
} from '../src/lib/auth.js';

function createMockEnv() {
  const kv = new Map();
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
    async list() { return { keys: [], list_complete: true }; },
  };
  return { env: { NAV_DB: {}, NAV_AUTH: navAuth }, kv };
}

function req(cookie = '') {
  const headers = cookie ? { Cookie: cookie } : {};
  return new Request('https://x/', { headers });
}

test('admin 会话滑动续期降频：新鲜会话不写 KV，超半窗口才续并记 lastRefresh', async () => {
  const { env, kv } = createMockEnv();
  const token = await createAdminSession(env);
  const origPut = env.NAV_AUTH.put;
  let putCalls = 0;
  env.NAV_AUTH.put = async (...args) => { putCalls += 1; return origPut(...args); };

  // 刚登录：elapsed ≈ 0 < 6h → 不续期
  const { authenticated } = await validateAdminSession(req(`nav_admin_session=${token}`), env);
  assert.equal(authenticated, true);
  assert.equal(putCalls, 0, '新鲜会话不应触发续期写');

  // 伪造 7 小时前登录（无 lastRefresh）→ elapsed > 6h → 续期并写 lastRefresh
  const staleToken = 'stale-token';
  const stalePayload = JSON.stringify({ createdAt: Date.now() - 7 * 3600 * 1000 });
  await env.NAV_AUTH.put('session:stale-token', stalePayload, { expirationTtl: 12 * 3600 });
  putCalls = 0;
  assert.equal((await validateAdminSession(req('nav_admin_session=stale-token'), env)).authenticated, true);
  assert.equal(putCalls, 1, '超半窗口应续期一次');
  const stored = JSON.parse(kv.get('session:stale-token').value);
  assert.ok(Number.isFinite(stored.lastRefresh), '续期后应写入 lastRefresh');

  // lastRefresh 刚写 → 再校验不续
  putCalls = 0;
  await validateAdminSession(req('nav_admin_session=stale-token'), env);
  assert.equal(putCalls, 0, '距上次续期不足半窗口应跳过');
});

test('isAdminAuthenticated 同请求内去重：锁中间件与渲染只做 1 次 KV 读', async () => {
  const { env } = createMockEnv();
  const token = await createAdminSession(env);
  const request = req(`nav_admin_session=${token}`);

  const origGet = env.NAV_AUTH.get;
  let getCalls = 0;
  env.NAV_AUTH.get = async (...args) => { getCalls += 1; return origGet(...args); };

  const [a, b] = await Promise.all([isAdminAuthenticated(request, env), isAdminAuthenticated(request, env)]);
  await isAdminAuthenticated(request, env);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(getCalls, 1, '同一 Request 多次校验只应做一次 KV 读');

  // 不同 Request → 重新校验
  getCalls = 0;
  await isAdminAuthenticated(req(`nav_admin_session=${token}`), env);
  assert.equal(getCalls, 1, '不同请求不受缓存影响');
});
