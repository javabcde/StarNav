// Worker 入口路由矩阵（index.js fetch/scheduled）——2026-08-16 架构评审收尾，
// 补齐 AGENTS.md 列出的「worker entry routing」覆盖缺口。全空 D1/KV mock 下验证
// 分派顺序：PWA → 整站锁（未配置放行）→ /api → /go → /admin|/static → 首页。
import test from 'node:test';
import { resetMigrationStateForTest } from '../src/services/migrationService.js';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys()).filter((name) => name.startsWith(prefix)).sort().map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

// 全空最小面：settings 缺省走代码默认、站点/分类/标签查询全空、迁移语句可执行。
function createMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() { return null; },
          async all() { return { results: [] }; },
          async run() { return { success: true, meta: { changes: 1 } }; },
        };
      },
      async batch() { return []; },
    },
  };
}

const env = createMockEnv();

test('路由：PWA 资源在整站锁之前放行（manifest 200 + JSON 内容类型）', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/manifest.webmanifest'), env, {});
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Content-Type').includes('application/manifest+json'));
});

test('路由：/api 未注册路径 404 JSON（整站锁未配置时放行，非锁页 302）', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/api/nope'), env, {});
  assert.equal(response.status, 404);
  assert.ok(response.headers.get('Content-Type').includes('application/json'));
  assert.ok(!response.headers.get('Location'), '未配置整站锁时不应重定向到锁页');
});

test('路由：/go/:id 走跳转处理器（站点不存在 → 404）', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/go/123'), env, {});
  assert.equal(response.status, 404);
});

test('路由：/admin 未登录渲染登录页 200', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/admin'), env, {});
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('Content-Type').includes('text/html'));
});

test('路由：/static/home.css 静态资源 200（ETag 协商）', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/static/home.css'), env, {});
  assert.equal(response.status, 200);
  assert.ok(response.headers.get('ETag'));
  const etag = response.headers.get('ETag');
  const notModified = await worker.fetch(new Request('https://nav.example.com/static/home.css', { headers: { 'If-None-Match': etag } }), env, {});
  assert.equal(notModified.status, 304);
});

test('路由：/ 首页 200（含 PWA 注册脚本）；?layout=grid 走布局片段路径', async () => {
  const home = await worker.fetch(new Request('https://nav.example.com/'), env, {});
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes("serviceWorker.register('/sw.js')"), '首页应含 PWA 注册脚本');

  const fragment = await worker.fetch(new Request('https://nav.example.com/?layout=grid'), env, {});
  assert.equal(fragment.status, 200);
});

test('路由：安全响应头统一注入（nosniff + frame 防护）', async () => {
  const response = await worker.fetch(new Request('https://nav.example.com/api/nope'), env, {});
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(response.headers.get('X-Frame-Options'));
});

test('兜底：处理器抛错 → 500 且不泄漏内部信息', async () => {
  // 重置迁移状态，让坏 env 在 ensureSchema 阶段即抛错（正常 env 已把状态缓存为 done）
  resetMigrationStateForTest();
  const badEnv = {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare() { throw new Error('boom'); },
    },
  };
  const response = await worker.fetch(new Request('https://nav.example.com/'), badEnv, {});
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.ok(!text.includes('boom'), '5xx 不应泄漏内部错误');
});

test('scheduled：健康检查 + 备份在 mock 下完成且不抛错', async () => {
  const tasks = [];
  const ctx = { waitUntil: (p) => tasks.push(p) };
  await worker.scheduled({}, env, ctx);
  await Promise.all(tasks);
});
