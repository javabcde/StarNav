import test from 'node:test';
import assert from 'node:assert/strict';

import { handleApiRequest } from '../src/handlers/api.js';

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

// 路由表测试只走鉴权路径（无 D1 访问）：命中即返回 401/403，未命中落 404。
function createMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare() {
        throw new Error('NAV_DB should not be touched by router tests');
      },
    },
  };
}

function call(path, { method = 'GET' } = {}) {
  return handleApiRequest(new Request(`https://example.com/api${path}`, { method }), createMockEnv(), {});
}

test('路由表：根路径与 /discovery 返回公开发现文档', async () => {
  for (const path of ['/', '/discovery']) {
    const response = await call(path);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.code, 200);
    assert.equal(body.name, 'StarNav Public API');
  }
});

test('路由表：/openapi.json 返回 OpenAPI 文档', async () => {
  const response = await call('/openapi.json');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.openapi, '3.0.3');
  assert.ok(body.paths && typeof body.paths === 'object');
});

test('路由表：未知路径与方法不匹配一律 404', async () => {
  assert.equal((await call('/nope')).status, 404);
  assert.equal((await call('/discovery', { method: 'POST' })).status, 404);
  assert.equal((await call('/openapi.json', { method: 'PUT' })).status, 404);
});

test('路由表：/api 前缀剥离后按表匹配（POST /tokens 进管理员门禁 401）', async () => {
  const response = await call('/tokens', { method: 'POST' });
  assert.equal(response.status, 401);
});

test('路由表：静态段优先于参数段——/sites/check-duplicate 不被 :id 吞掉', async () => {
  // check-duplicate 是 GET-only：GET 命中其门禁（401），PUT 无匹配（404）
  assert.equal((await call('/sites/check-duplicate')).status, 401);
  assert.equal((await call('/sites/check-duplicate', { method: 'PUT' })).status, 404);
});

test('路由表：参数段仅数字 id 命中 sites/:id', async () => {
  assert.equal((await call('/sites/abc')).status, 404);
  assert.equal((await call('/sites/123')).status, 401);
});

test('路由表：/site/:id/ensure-favicon 命中（id 为中段数字，门禁在 id 校验前）', async () => {
  assert.equal((await call('/site/5/ensure-favicon', { method: 'POST' })).status, 401);
  assert.equal((await call('/site/5/other', { method: 'POST' })).status, 404);
});

test('路由表：tokens/:id 仅 DELETE 进门禁，其余方法直接 404', async () => {
  assert.equal((await call('/tokens/abc', { method: 'DELETE' })).status, 401);
  assert.equal((await call('/tokens/abc', { method: 'PUT' })).status, 404);
});

test('路由表：backups 具体路径先于参数路径匹配', async () => {
  assert.equal((await call('/backups/webdav-settings')).status, 401);
  assert.equal((await call('/backups/abc')).status, 401);
});

test('路由表：别名路径 /config 与 /pending 与主路径等价', async () => {
  assert.equal((await call('/config/123')).status, 401);
  assert.equal((await call('/pending')).status, 401);
  assert.equal((await call('/pending/7', { method: 'PUT' })).status, 401);
});

test('路由表：集合路径未知方法不进门禁（PUT /categories → 404）', async () => {
  assert.equal((await call('/categories', { method: 'PUT' })).status, 404);
  assert.equal((await call('/categories/abc', { method: 'DELETE' })).status, 401);
});

test('路由表：管理端点接线——/operation-logs 与 /backups/webdav-settings GET 未登录 401、登录后 200', async () => {
  assert.equal((await call('/operation-logs')).status, 401);
  assert.equal((await call('/backups/webdav-settings')).status, 401);

  // 登录态验证接线（此前两端点从路由表丢失：/operation-logs 404、webdav-settings 落入 :id 404）
  const env = {
    NAV_AUTH: createMemoryKv(),
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
  const now = Date.now();
  await env.NAV_AUTH.put('session:admin-1', JSON.stringify({ createdAt: now - 1000, lastRefresh: now - 1000 }));
  const authed = (path, { method = 'GET' } = {}) =>
    handleApiRequest(new Request(`https://example.com/api${path}`, { method, headers: { Cookie: 'nav_admin_session=admin-1' } }), env, {});
  assert.equal((await authed('/operation-logs')).status, 200);
  assert.equal((await authed('/backups/webdav-settings')).status, 200);
});

test('路由表：re() 参数段端点方法门槛——错误方法 404 不进门禁，正确方法进门禁 401', async () => {
  // ensure-favicon
  assert.equal((await call('/site/1/ensure-favicon')).status, 404);
  assert.equal((await call('/site/1/ensure-favicon', { method: 'POST' })).status, 401);
  // reorder
  assert.equal((await call('/config/reorder')).status, 404);
  assert.equal((await call('/config/reorder', { method: 'POST' })).status, 401);
  // import / import-preview
  assert.equal((await call('/config/import')).status, 404);
  assert.equal((await call('/config/import/preview')).status, 404);
  // export 仅 GET
  assert.equal((await call('/config/export', { method: 'POST' })).status, 404);
  assert.equal((await call('/config/export')).status, 401);
  // check / unsync
  assert.equal((await call('/config/123/check')).status, 404);
  assert.equal((await call('/config/123/check', { method: 'POST' })).status, 401);
  assert.equal((await call('/config/123/unsync')).status, 404);
  assert.equal((await call('/config/123/unsync', { method: 'POST' })).status, 401);
});

test('路由表：集合路径非标方法 404 不进门禁（DELETE /tokens /webhooks /backups），:id 仍进门禁', async () => {
  assert.equal((await call('/tokens', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/webhooks', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/backups', { method: 'DELETE' })).status, 404);
  assert.equal((await call('/tokens/abc', { method: 'DELETE' })).status, 401);
  assert.equal((await call('/webhooks/abc', { method: 'DELETE' })).status, 401);
  assert.equal((await call('/backups/abc', { method: 'DELETE' })).status, 401);
});
