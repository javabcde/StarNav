import test from 'node:test';
import assert from 'node:assert/strict';

import { handleApiRequest } from '../src/handlers/api.js';
import { createApiToken } from '../src/lib/auth.js';

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
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    },
  };
}

function createEnv({ site } = {}) {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (/FROM sites/i.test(sql)) return site || null;
                return null;
              },
              async all() {
                return { results: [] };
              },
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

function post(path, token) {
  return new Request(`https://example.com/api${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// getFavicon 对 5 个源逐次 fetch；返回 image 响应 = 第一个源命中（1 次 fetch），
// 返回 404 = 5 源全试（5 次 fetch）后放弃。example.test 不在 SSRF 保留列表。
function faviconSuccess() {
  return new Response('x', { status: 200, headers: { 'content-type': 'image/png' } });
}
function faviconMissing() {
  return new Response('x', { status: 404 });
}

test('ensure-favicon：无凭据请求返回 401，不执行抓取', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const env = createEnv({ site: { id: 1, url: 'https://example.test', logo: '' } });
  const response = await handleApiRequest(post('/site/1/ensure-favicon'), env, {});
  assert.equal(response.status, 401);
  assert.equal(fetchMock.mock.callCount(), 0, '未授权不应触发抓取');
});

test('ensure-favicon：有效 token（write scope）可调，返回 updated + favicon', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => faviconSuccess());
  const env = createEnv({ site: { id: 1, url: 'https://example.test', logo: '' } });
  const { token } = await createApiToken(env, { name: 'plugin-test' }); // 默认 read + write

  const response = await handleApiRequest(post('/site/1/ensure-favicon', token), env, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.code, 200);
  assert.equal(body.data.updated, true);
  assert.equal(body.data.reason, 'filled');
  assert.match(body.data.favicon, /^https:\/\//);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test('ensure-favicon：无 write scope 的 token 返回 403', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const env = createEnv({ site: { id: 1, url: 'https://example.test', logo: '' } });
  const { token } = await createApiToken(env, { name: 'readonly', scopes: ['read'] });

  const response = await handleApiRequest(post('/site/1/ensure-favicon', token), env, {});
  assert.equal(response.status, 403);
  assert.equal(fetchMock.mock.callCount(), 0, 'scope 不足不应触发抓取');
});

test('ensure-favicon：无效 id 返回 400，站点不存在返回 404', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const env = createEnv();
  const { token } = await createApiToken(env, { name: 'plugin-test' });

  const badId = await handleApiRequest(post('/site/abc/ensure-favicon', token), env, {});
  assert.equal(badId.status, 400, '非数字 id 应 400');

  const missing = await handleApiRequest(post('/site/999/ensure-favicon', token), env, {});
  assert.equal(missing.status, 404, '不存在的站点应 404');
});

test('ensure-favicon：已标记失败的站点跳过抓取（reason=already-failed）', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const env = createEnv({ site: { id: 5, url: 'https://example.test', logo: '' } });
  await env.NAV_AUTH.put('favicon:failed:5', '1');
  const { token } = await createApiToken(env, { name: 'plugin-test' });

  const response = await handleApiRequest(post('/site/5/ensure-favicon', token), env, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.updated, false);
  assert.equal(body.data.reason, 'already-failed');
  assert.equal(fetchMock.mock.callCount(), 0, '已标记失败不应触发抓取');
});

test('ensure-favicon：抓取失败写永久标记并返回 reason=no-favicon', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => faviconMissing());
  const env = createEnv({ site: { id: 6, url: 'https://example.test', logo: '' } });
  const { token } = await createApiToken(env, { name: 'plugin-test' });

  const response = await handleApiRequest(post('/site/6/ensure-favicon', token), env, {});
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.updated, false);
  assert.equal(body.data.reason, 'no-favicon');
  assert.equal(fetchMock.mock.callCount(), 5, '5 源全失败后写标记');
  assert.equal(await env.NAV_AUTH.get('favicon:failed:6'), '1');
});
