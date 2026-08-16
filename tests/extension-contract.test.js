import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 与 popup-logic.test.js 同模式：仓库根 package.json 为 "type": "module"，
// 用 vm 在当前 realm 执行 UMD 真实文件取全局导出。
const contractSource = readFileSync(new URL('../extensions/browser-bookmark/extension-contract.js', import.meta.url), 'utf8');
vm.runInThisContext(contractSource);
const Contract = globalThis.Contract;

test('契约常量：缓存键/形状字段/TTL 默认/存储键/消息类型/配置键清单', () => {
  assert.equal(Contract.BROWSE_CACHE_KEY, 'browse:cache:v1');
  assert.equal(Contract.BROWSE_CACHE_DEFAULT_MINUTES, 5);
  assert.deepEqual(Contract.BROWSE_CACHE_FIELDS, ['kind', 'fetchedAt', 'ttlMinutes', 'items', 'total', 'categories']);
  assert.equal(Contract.STORAGE_KEYS.BROWSE_CACHE, 'browse:cache:v1');
  assert.equal(Contract.STORAGE_KEYS.BROWSE_VIEW, 'browse:view:v1');
  assert.equal(Contract.STORAGE_KEYS.FAVICON_DEBUG_LAST, 'favicon:debug:last');
  assert.equal(Contract.MESSAGE_TYPES.ENSURE_FAVICON, 'ensure-favicon');
  assert.equal(Contract.MESSAGE_TYPES.SYNC_SITE_NAME, 'sync-site-name');
  assert.ok(Contract.CONFIG_KEYS.sync.includes('baseUrl'));
  assert.ok(Contract.CONFIG_KEYS.sync.includes('token'));
  assert.ok(Contract.CONFIG_KEYS.sync.includes('defaultCategory'));
  assert.ok(Contract.CONFIG_KEYS.local.includes('categories'));
});

test('normalizeBaseUrl：去尾部斜杠与空白', () => {
  assert.equal(Contract.normalizeBaseUrl('https://nav.example.com/'), 'https://nav.example.com');
  assert.equal(Contract.normalizeBaseUrl('  https://nav.example.com///  '), 'https://nav.example.com');
  assert.equal(Contract.normalizeBaseUrl(''), '');
  assert.equal(Contract.normalizeBaseUrl(null), '');
});

test('apiFetch：拼接 URL、鉴权头、JSON 头；成功返回解析 JSON', async (t) => {
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  });
  const data = await Contract.apiFetch('/api/sites', {
    baseUrl: 'https://nav.example.com/',
    token: 'tok-123',
    method: 'POST',
    body: '{"a":1}',
  });
  assert.deepEqual(data, { ok: 1 });
  assert.equal(captured.url, 'https://nav.example.com/api/sites');
  assert.equal(captured.init.headers.Authorization, 'Bearer tok-123');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
});

test('apiFetch：非 JSON 响应兜底为 { raw }，不带 token 时不加鉴权头', async (t) => {
  let captured = null;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    captured = init;
    return new Response('not-json', { status: 200 });
  });
  const data = await Contract.apiFetch('/api/config', { baseUrl: 'https://nav.example.com' });
  assert.deepEqual(data, { raw: 'not-json' });
  assert.equal(captured.headers.Authorization, undefined);
});

test('apiFetch：!ok 抛错并附带 status/data（文案取 data.message）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 500, message: 'boom' }), { status: 500 }));
  await assert.rejects(
    Contract.apiFetch('/api/x', { baseUrl: 'https://nav.example.com', token: 't' }),
    (err) => err.message === 'boom' && err.status === 500 && err.data.code === 500,
  );
});

test('apiFetch：!ok 无 message 时文案回退 HTTP 状态', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 403 }));
  await assert.rejects(
    Contract.apiFetch('/api/x', { baseUrl: 'https://nav.example.com', token: 't' }),
    (err) => err.message === '请求失败：HTTP 403' && err.status === 403,
  );
});

test('apiFetch：timeoutMs 超时抛 AbortError 且文案为连接超时', async (t) => {
  t.mock.method(globalThis, 'fetch', (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const e = new Error('The operation was aborted.');
      e.name = 'AbortError';
      reject(e);
    });
  }));
  await assert.rejects(
    Contract.apiFetch('/api/slow', { baseUrl: 'https://nav.example.com', token: 't', timeoutMs: 50 }),
    (err) => err.name === 'AbortError' && err.message.startsWith('连接超时（') && err.message.includes('秒）'),
  );
});

test('apiFetch：默认无超时，慢响应正常返回', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return new Response(JSON.stringify({ slow: true }), { status: 200 });
  });
  const data = await Contract.apiFetch('/api/slow', { baseUrl: 'https://nav.example.com' });
  assert.deepEqual(data, { slow: true });
});

test('apiFetch：baseUrl 缺失抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
  await assert.rejects(Contract.apiFetch('/api/x', {}), (err) => err.message === '请先填写 StarNav 地址');
});

test('buildCollectPayload：popup 默认值语义（name/url trim、catelog 回退未分类、visibility 默认 public、tags 字符串）', () => {
  const payload = Contract.buildCollectPayload({ name: '  A  ', url: ' https://a.com ' });
  assert.deepEqual(payload, {
    name: 'A',
    url: 'https://a.com',
    desc: '',
    catelog: '未分类',
    tags: '',
    visibility: 'public',
    logo: '',
  });
});

test('buildCollectPayload：background 右键收藏参数组合（desc/visibility/logo/catelog 覆盖默认）', () => {
  const payload = Contract.buildCollectPayload({
    name: 'B',
    url: 'https://b.com',
    catelog: '工具',
    desc: '通过浏览器插件一键收藏',
    visibility: 'public',
    logo: 'https://b.com/api/favicon?url=https%3A%2F%2Fb.com',
  });
  assert.equal(payload.catelog, '工具');
  assert.equal(payload.desc, '通过浏览器插件一键收藏');
  assert.equal(payload.visibility, 'public');
  assert.equal(payload.logo, 'https://b.com/api/favicon?url=https%3A%2F%2Fb.com');
});

test('buildCollectPayload：tags 数组透传、visibility 空回退 public', () => {
  const arrayTags = Contract.buildCollectPayload({ name: 'C', url: 'https://c.com', tags: ['x', 'y'] });
  assert.deepEqual(arrayTags.tags, ['x', 'y']);
  const emptyVis = Contract.buildCollectPayload({ name: 'D', url: 'https://d.com', visibility: '' });
  assert.equal(emptyVis.visibility, 'public');
});
