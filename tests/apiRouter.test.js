import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiToken } from '../src/lib/auth.js';
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

// ── /spaces 资源模块（GET 按访问上下文过滤可见性 + 冻结期写路径）──────────

const SPACES_ROWS = [
  { id: 1, name: '公开空间', slug: 'public-space', visibility: 'public', sort_order: 1 },
  { id: 2, name: '私人空间', slug: 'private-space', visibility: 'private', sort_order: 2 },
  { id: 3, name: '管理空间', slug: 'admin-space', visibility: 'admin_only', sort_order: 3 },
];

function createSpacesMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare() {
        return {
          bind() {
            return this;
          },
          async all() {
            return { results: SPACES_ROWS };
          },
        };
      },
    },
  };
}

async function seedAdminSession(env) {
  const now = Date.now();
  await env.NAV_AUTH.put('session:admin-1', JSON.stringify({ createdAt: now - 1000, lastRefresh: now - 1000 }));
  return 'nav_admin_session=admin-1';
}

test('路由表：GET /spaces 匿名仅见 public——private/admin_only 被过滤', async () => {
  const response = await handleApiRequest(new Request('https://example.com/api/spaces'), createSpacesMockEnv(), {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.code, 200);
  assert.deepEqual(body.data.map((space) => space.slug), ['public-space'], '匿名只见公开空间');
  assert.equal(body.total, 1);
});

test('路由表：GET /spaces 管理员会话返回全量空间', async () => {
  const env = createSpacesMockEnv();
  const cookie = await seedAdminSession(env);
  const response = await handleApiRequest(new Request('https://example.com/api/spaces', {
    headers: { Cookie: cookie },
  }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.total, 3, '管理员会话应看到全部空间');
});

test('路由表：GET /spaces 私人书签解锁会话可见 private 空间（不含 admin_only）', async () => {
  const env = createSpacesMockEnv();
  await env.NAV_AUTH.put('private-bookmarks:access:unlock-1', JSON.stringify({ createdAt: Date.now(), duration: '12h', ttl: 43200 }));
  const response = await handleApiRequest(new Request('https://example.com/api/spaces', {
    headers: { Cookie: 'nav_private_bookmarks_access=unlock-1' },
  }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((space) => space.slug), ['public-space', 'private-space'], '解锁会话可见 private 空间');
});

test('路由表：GET /spaces 有效 Bearer Token 同样可见 private 空间（ADR-0002 token 语义）', async () => {
  const env = createSpacesMockEnv();
  const { token } = await createApiToken(env, { name: 'Read client', scopes: ['read'] });
  const response = await handleApiRequest(new Request('https://example.com/api/spaces', {
    headers: { Authorization: `Bearer ${token}` },
  }), env, {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data.map((space) => space.slug), ['public-space', 'private-space'], '有效 token 亦授予 private 空间读取');
});

test('路由表：POST /spaces 未登录 401，管理员 cookie 过门禁后 409 冻结', async () => {
  const env = createSpacesMockEnv();
  const anon = await handleApiRequest(new Request('https://example.com/api/spaces', { method: 'POST' }), env, {});
  assert.equal(anon.status, 401);

  const cookie = await seedAdminSession(env);
  const frozen = await handleApiRequest(new Request('https://example.com/api/spaces', {
    method: 'POST',
    headers: { Cookie: cookie },
  }), env, {});
  assert.equal(frozen.status, 409);
  const body = await frozen.json();
  assert.equal(body.code, 409);
  assert.equal(body.message, '空间管理功能当前处于稳定化冻结状态，暂不支持新增空间。');
});

test('路由表：PUT/DELETE /spaces/:id 未登录 401，管理员 409 冻结文案逐字不变', async () => {
  const env = createSpacesMockEnv();
  assert.equal((await handleApiRequest(new Request('https://example.com/api/spaces/2', { method: 'PUT' }), env, {})).status, 401);
  assert.equal((await handleApiRequest(new Request('https://example.com/api/spaces/2', { method: 'DELETE' }), env, {})).status, 401);

  const cookie = await seedAdminSession(env);
  const put = await handleApiRequest(new Request('https://example.com/api/spaces/2', {
    method: 'PUT',
    headers: { Cookie: cookie },
  }), env, {});
  assert.equal(put.status, 409);
  assert.equal((await put.json()).message, '空间管理功能当前处于稳定化冻结状态，暂不支持修改空间。');

  const del = await handleApiRequest(new Request('https://example.com/api/spaces/2', {
    method: 'DELETE',
    headers: { Cookie: cookie },
  }), env, {});
  assert.equal(del.status, 409);
  assert.equal((await del.json()).message, '空间管理功能当前处于稳定化冻结状态，暂不支持删除空间。');
});

test('路由表：/spaces 未注册方法/路径 404 不进门禁不触 D1', async () => {
  assert.equal((await call('/spaces', { method: 'PUT' })).status, 404);
  assert.equal((await call('/spaces/1')).status, 404);
  assert.equal((await call('/spaces/1', { method: 'POST' })).status, 404);
  assert.equal((await call('/spaces/a/b', { method: 'PUT' })).status, 404);
});
