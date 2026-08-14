import test from 'node:test';
import assert from 'node:assert/strict';

import { handleGoRequest } from '../src/handlers/go.js';

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
  };
}

function createMockEnv(site) {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind() {
            return {
              async first() {
                if (/FROM sites s/i.test(sql)) return site;
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

test('GET /go/:id returns 404 for inaccessible private bookmarks without leaking category', async () => {
  const response = await handleGoRequest(new Request('https://example.com/go/42'), createMockEnv({
    id: 42,
    name: 'Secret',
    url: 'https://secret.example.com',
    catelog: '私人书签',
    visibility: 'private',
  }), {});
  const body = await response.json();

  assert.equal(response.status, 404);
  assert.equal(body.message, 'Site not found');
  assert.equal(response.headers.get('Location'), null);
  assert.ok(!JSON.stringify(body).includes('私人书签'));
});

test('GET /go/:id still redirects accessible public bookmarks via jump page', async () => {
  const waitUntilTasks = [];
  const response = await handleGoRequest(new Request('https://example.com/go/7?from_catalog=工具'), createMockEnv({
    id: 7,
    name: 'Example',
    url: 'https://example.com/path',
    logo: 'https://icon.example/7.png',
    catelog: '工具',
    visibility: 'public',
  }), {
    waitUntil(task) {
      waitUntilTasks.push(task);
    },
  });
  const html = await response.text();
  await Promise.all(waitUntilTasks);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type') || '', /text\/html/);
  assert.match(html, /https:\/\/example\.com\/path/);
  assert.match(html, /catalog=%E5%B7%A5%E5%85%B7/);
});

test('GET /go/:id 无图标书签后台自动补全（成功不标记），不阻塞跳转', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }));
  const env = createMockEnv({ id: 9, name: 'X', url: 'https://x.example.com', catelog: '工具', visibility: 'public' });
  const waitUntilTasks = [];
  const response = await handleGoRequest(new Request('https://example.com/go/9'), env, {
    waitUntil(task) { waitUntilTasks.push(task); },
  });
  const html = await response.text();
  assert.equal(response.status, 200, '跳转页应立即返回');
  await Promise.all(waitUntilTasks);
  assert.equal(fetchMock.mock.callCount(), 1, '无图标应触发一次抓取');
  assert.equal(await env.NAV_AUTH.get('favicon:failed:9'), null, '抓取成功不写失败标记');
  assert.match(html, /https:\/\/x\.example\.com/);
});

test('GET /go/:id 已有图标不触发抓取', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const env = createMockEnv({ id: 10, name: 'X', url: 'https://x.example.com', logo: 'https://icon.example/10.png', catelog: '工具', visibility: 'public' });
  const waitUntilTasks = [];
  const response = await handleGoRequest(new Request('https://example.com/go/10'), env, {
    waitUntil(task) { waitUntilTasks.push(task); },
  });
  await response.text();
  await Promise.all(waitUntilTasks);
  assert.equal(fetchMock.mock.callCount(), 0, '已有图标不应触发抓取');
});

test('GET /go/:id 抓取失败写永久失败标记，下次点击不再抓', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('x', { status: 404 }));
  const env = createMockEnv({ id: 11, name: 'X', url: 'https://x.example.com', catelog: '工具', visibility: 'public' });
  const waitUntilTasks = [];
  await handleGoRequest(new Request('https://example.com/go/11'), env, {
    waitUntil(task) { waitUntilTasks.push(task); },
  });
  await Promise.all(waitUntilTasks);
  assert.equal(fetchMock.mock.callCount(), 5, '5 源全失败后写永久标记');
  assert.equal(await env.NAV_AUTH.get('favicon:failed:11'), '1', '失败应写永久标记');

  // 已标记：再次点击不触发抓取
  const again = await handleGoRequest(new Request('https://example.com/go/11'), env, {
    waitUntil(task) { waitUntilTasks.push(task); },
  });
  await again.text();
  await Promise.all(waitUntilTasks);
  assert.equal(fetchMock.mock.callCount(), 5, '已标记失败不应再次抓取');
});
