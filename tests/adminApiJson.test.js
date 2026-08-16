// 后台统一 API 客户端（clientLogic.apiJson）单测：JSON 解析、非 JSON 兜底、
// GET 失败静默重试（Abort 中断不重试）、非 GET 失败直接抛。
// 2026-08-16 架构评审收尾：apiJson 自 adminJs 模板收编至 clientLogic，测试即行为契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { apiJson } from '../src/pages/clientLogic.js';

function mockFetch(t, impl) {
  t.mock.method(globalThis, 'fetch', impl);
}

test('apiJson：成功 JSON 响应解析为对象', async (t) => {
  mockFetch(t, async () => new Response(JSON.stringify({ code: 200, data: [1] }), { status: 200 }));
  const data = await apiJson('/api/config');
  assert.deepEqual(data, { code: 200, data: [1] });
});

test('apiJson：非 JSON 响应兜底为 {code, message}', async (t) => {
  mockFetch(t, async () => new Response('Internal Server Error', { status: 500, statusText: 'Server Error' }));
  const data = await apiJson('/api/config');
  assert.deepEqual(data, { code: 500, message: 'Internal Server Error' });
});

test('apiJson：GET 失败静默重试一次后成功', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify({ code: 200 }), { status: 200 });
  });
  t.mock.method(globalThis, 'setTimeout', (fn) => fn()); // 重试间隔不真实等待
  const data = await apiJson('/api/config');
  assert.deepEqual(data, { code: 200 });
  assert.equal(calls, 2);
});

test('apiJson：AbortError 不重试直接抛', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls += 1;
    throw new DOMException('aborted', 'AbortError');
  });
  await assert.rejects(() => apiJson('/api/config', { signal: new AbortController().signal }), /aborted/);
  assert.equal(calls, 1);
});

test('apiJson：非 GET 失败不重试直接抛', async (t) => {
  let calls = 0;
  mockFetch(t, async () => {
    calls += 1;
    throw new TypeError('Failed to fetch');
  });
  await assert.rejects(() => apiJson('/api/config', { method: 'POST' }), /Failed to fetch/);
  assert.equal(calls, 1);
});
