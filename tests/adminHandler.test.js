// 管理端 handler 行为测试（handlers/admin.js）——2026-08-16 架构评审候选 3 补齐：
// 登录 POST 成功/失败/限速 429、登出、已登录 shell 渲染此前零覆盖
// （workerEntry.test.js 只断言了未登录 200；adminApiJson.test.js 只测 clientLogic）。
import test from 'node:test';
import assert from 'node:assert/strict';

import { handleAdminRequest } from '../src/handlers/admin.js';
import { buildSessionCookie, createAdminSession } from '../src/services/unlockSessionService.js';
import { hashPassword } from '../src/lib/crypto.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: [] };
    },
  };
}

async function createMockEnv({ password = 'secret' } = {}) {
  const kv = createMemoryKv();
  await kv.put('admin_username', 'admin');
  await kv.put('admin_password', await hashPassword(password));
  return {
    NAV_AUTH: kv,
    NAV_DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async first() {
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        return [];
      },
    },
  };
}

function loginRequest(env, body, { ip = '1.2.3.4' } = {}) {
  return new Request('https://nav.example.com/admin', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'CF-Connecting-IP': ip,
    },
    body,
  });
}

test('admin 登录：错误密码渲染错误页并计数限速键，不种会话 cookie', async () => {
  const env = await createMockEnv();
  const response = await handleAdminRequest(loginRequest(env, 'name=admin&password=wrong'), env, {});

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(html.includes('账号或密码错误'), '应渲染错误提示');
  assert.ok(html.includes('loginForm'), '应仍是登录页');
  assert.equal(response.headers.get('Set-Cookie'), null, '失败不得种会话 cookie');

  const raw = await env.NAV_AUTH.get('login_fail:1.2.3.4');
  assert.equal(JSON.parse(raw).count, 1, '失败计数应写入 KV');
});

test('admin 登录：正确密码 302 + 种会话 cookie + 清除失败计数', async () => {
  const env = await createMockEnv();
  await env.NAV_AUTH.put('login_fail:1.2.3.4', JSON.stringify({ count: 3, updatedAt: Date.now() }));

  const response = await handleAdminRequest(loginRequest(env, 'name=admin&password=secret'), env, {});

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/admin');
  const cookie = response.headers.get('Set-Cookie') || '';
  assert.ok(cookie.includes('nav_admin_session='), '应种管理员会话 cookie');
  assert.equal(await env.NAV_AUTH.get('login_fail:1.2.3.4'), null, '成功后应清除失败计数');

  const token = cookie.split('nav_admin_session=')[1].split(';')[0];
  assert.ok(await env.NAV_AUTH.get(`session:${token}`), '会话 token 应写入 KV');
});

test('admin 登录：达到阈值 429 且不再校验凭据', async () => {
  const env = await createMockEnv();
  await env.NAV_AUTH.put('login_fail:1.2.3.4', JSON.stringify({ count: 5, updatedAt: Date.now() }));

  const response = await handleAdminRequest(loginRequest(env, 'name=admin&password=secret'), env, {});
  assert.equal(response.status, 429);
  const html = await response.text();
  assert.ok(html.includes('过于频繁'), '应提示限速');
});

test('admin 登出：POST 删除 KV 会话并清 cookie（maxAge=0）', async () => {
  const env = await createMockEnv();
  const token = await createAdminSession(env);
  assert.ok(await env.NAV_AUTH.get(`session:${token}`), '前置：会话存在');

  const request = new Request('https://nav.example.com/admin/logout', {
    method: 'POST',
    headers: { Cookie: buildSessionCookie(token) },
  });
  const response = await handleAdminRequest(request, env, {});

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/admin');
  assert.match(response.headers.get('Set-Cookie') || '', /Max-Age=0/, '登出应清除 cookie');
  assert.equal(await env.NAV_AUTH.get(`session:${token}`), null, 'KV 会话应删除');
});

test('admin GET：已登录渲染后台壳，未登录渲染登录页', async () => {
  const env = await createMockEnv();

  const token = await createAdminSession(env);
  const authed = await handleAdminRequest(new Request('https://nav.example.com/admin', {
    headers: { Cookie: buildSessionCookie(token) },
  }), env, {});
  assert.equal(authed.status, 200);
  const authedHtml = await authed.text();
  assert.ok(!authedHtml.includes('loginForm'), '已登录不得渲染登录页');

  const anon = await handleAdminRequest(new Request('https://nav.example.com/admin'), env, {});
  assert.equal(anon.status, 200);
  const anonHtml = await anon.text();
  assert.ok(anonHtml.includes('loginForm'), '匿名应渲染登录页');
});

test('admin 登出：非 POST 405', async () => {
  const env = await createMockEnv();
  const response = await handleAdminRequest(new Request('https://nav.example.com/admin/logout'), env, {});
  assert.equal(response.status, 405);
});
