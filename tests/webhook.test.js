// Webhook 策略叶（webhookPolicy.js）直测 + 投递集成测试（webhookService.dispatchWebhooks）
// ——2026-08-16 架构评审候选 4：策略（匹配/整形/签名）此前全部私有零测试；
// dispatchWebhooks 簿记从逐条全表重写改为批量写回，KV 写次数锁定为 1。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildWebhookPayload,
  eventMatches,
  isValidWebhookUrl,
  publicWebhook,
  sanitizeWebhook,
  signPayload,
} from '../src/services/webhookPolicy.js';
import { createWebhook, dispatchWebhooks, listWebhooks, testWebhook } from '../src/services/webhookService.js';

function createMemoryKv() {
  const store = new Map();
  let putCount = 0;
  return {
    _putCount() {
      return putCount;
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      putCount += 1;
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

function createMockEnv() {
  return {
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
}

// ── 策略叶直测 ────────────────────────────────────────────────

test('eventMatches：* 通配、精确 action、组通配 site.*，不匹配事件拒绝', () => {
  const any = { events: ['*'] };
  assert.equal(eventMatches(any, 'site.create'), true);
  assert.equal(eventMatches(any, 'anything.else'), true);

  const exact = { events: ['site.create'] };
  assert.equal(eventMatches(exact, 'site.create'), true);
  assert.equal(eventMatches(exact, 'site.update'), false);

  const group = { events: ['site.*', 'backup.create'] };
  assert.equal(eventMatches(group, 'site.update'), true, '组通配应命中同组任意 action');
  assert.equal(eventMatches(group, 'backup.create'), true, '精确事件应命中');
  assert.equal(eventMatches(group, 'category.create'), false);
});

test('sanitizeWebhook：默认值语义（名称回退、事件归一、enabled 缺省 true）', () => {
  const webhook = sanitizeWebhook({ id: 'a', url: 'https://x.example.com' });
  assert.equal(webhook.name, '未命名 WebHook');
  assert.deepEqual(webhook.events, ['*']);
  assert.equal(webhook.enabled, true);
  assert.equal(webhook.secret, '');

  const disabled = sanitizeWebhook({ id: 'b', url: 'https://x.example.com', enabled: false });
  assert.equal(disabled.enabled, false);
});

test('isValidWebhookUrl：仅 https 有效', () => {
  assert.equal(isValidWebhookUrl('https://hooks.example.com/x'), true);
  assert.equal(isValidWebhookUrl('http://hooks.example.com/x'), false);
  assert.equal(isValidWebhookUrl('not a url'), false);
});

test('signPayload：空 secret 返回空串；HMAC-SHA256 十六进制确定性', async () => {
  assert.equal(await signPayload('', '{}'), '');
  const a = await signPayload('secret', '{"event":"site.create"}');
  const b = await signPayload('secret', '{"event":"site.create"}');
  const c = await signPayload('secret', '{"event":"site.update"}');
  assert.equal(a, b, '同输入同输出');
  assert.notEqual(a, c, '不同输入不同签名');
  assert.match(a, /^[0-9a-f]{64}$/, '应为 64 位十六进制');
});

test('publicWebhook：secret 剥除，hasSecret 反映存在性', () => {
  const pub = publicWebhook({ id: 'a', secret: 's', name: 'n' });
  assert.equal(pub.secret, undefined);
  assert.equal(pub.hasSecret, true);
  assert.equal(publicWebhook({ id: 'b' }).hasSecret, false);
});

test('buildWebhookPayload：operation 字段投影 + 时间戳可注入', () => {
  const payload = buildWebhookPayload(
    { action: 'site.create', target: 'site', targetId: '7', summary: '新增', detail: 'd', ip: '1.2.3.4' },
    '2026-08-16T00:00:00.000Z',
  );
  assert.deepEqual(payload, {
    event: 'site.create',
    action: 'site.create',
    target: 'site',
    targetId: '7',
    summary: '新增',
    detail: 'd',
    ip: '1.2.3.4',
    timestamp: '2026-08-16T00:00:00.000Z',
  });
});

// ── dispatchWebhooks 集成 ─────────────────────────────────────

test('dispatchWebhooks：匹配/禁用/组通配分流，签名头正确，KV 簿记一次写', async (t) => {
  const env = createMockEnv();
  const okHook = await createWebhook(env, { name: 'ok', url: 'https://hooks.example.com/a', events: ['site.create'], secret: 's3cret' });
  const failHook = await createWebhook(env, { name: 'fail', url: 'https://hooks.example.com/b', events: ['site.*'] });
  await createWebhook(env, { name: 'disabled', url: 'https://hooks.example.com/c', events: ['*'], enabled: false });
  await createWebhook(env, { name: 'other', url: 'https://hooks.example.com/d', events: ['backup.create'] });
  const okUpdatedAt = (await listWebhooks(env)).find((item) => item.name === 'ok').updatedAt;

  const seen = [];
  const putCountBefore = env.NAV_AUTH._putCount();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const body = options.body;
    seen.push({ url: String(url), options, body });
    if (String(url).includes('/b')) return new Response('boom', { status: 500 });
    return new Response('ok', { status: 200 });
  });

  const result = await dispatchWebhooks(env, { action: 'site.create', target: 'site', targetId: '1', summary: '新增书签', ip: '9.9.9.9' });

  assert.equal(result.sent, 1, '仅 ok 钩子成功');
  assert.equal(result.failed, 1, 'fail 钩子 500 记失败');
  assert.equal(seen.length, 2, '禁用与不匹配的钩子不得投递');

  // 签名校验：X-StarNav-Signature = sha256=<HMAC(secret, body)>
  const [okCall, failCall] = seen;
  const expectedSig = await signPayload('s3cret', okCall.body);
  assert.equal(okCall.options.headers['X-StarNav-Signature'], `sha256=${expectedSig}`);
  assert.ok(String(okCall.options.headers['Content-Type']).startsWith('application/json'), '应带 JSON 内容类型（Node fetch 会归一化 charset）');
  assert.equal(JSON.parse(okCall.body).action, 'site.create');
  assert.equal(JSON.parse(okCall.body).ip, '9.9.9.9');

  // 簿记：一次读 + 一次写（创建 4 个钩子已耗 4 次写，投递后恰 +1）
  assert.equal(env.NAV_AUTH._putCount(), putCountBefore + 1, '批量簿记应只写一次 KV');

  const stored = await listWebhooks(env);
  const byName = Object.fromEntries(stored.map((item) => [item.name, item]));
  assert.equal(byName.ok.lastStatus, 200);
  assert.equal(byName.ok.lastError, null);
  assert.ok(byName.ok.lastTriggeredAt, '成功钩子应记录触发时间');
  assert.equal(byName.ok.updatedAt, okUpdatedAt, '投递簿记不得推进目标钩子的 updatedAt（保留「上次配置修改」语义）');
  assert.match(byName.fail.lastError, /HTTP 500/);
  assert.equal(byName.disabled.lastTriggeredAt, null, '未投递钩子不得更新簿记');
});

test('dispatchWebhooks：投递期间并发的配置变更不被投递前快照覆盖', async (t) => {
  const env = createMockEnv();
  await createWebhook(env, { name: 'a', url: 'https://hooks.example.com/a', events: ['*'] });

  let createdDuringDispatch = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!createdDuringDispatch) {
      // 模拟投递进行中的并发写：管理员在 fetch 期间新建 webhook
      createdDuringDispatch = true;
      await createWebhook(env, { name: 'concurrent', url: 'https://hooks.example.com/c', events: ['*'] });
    }
    return new Response('ok', { status: 200 });
  });

  await dispatchWebhooks(env, { action: 'site.create' });

  const stored = await listWebhooks(env);
  assert.ok(stored.some((item) => item.name === 'concurrent'), '投递期间新建的钩子必须保留（批量写回前重读）');
});

test('dispatchWebhooks：投递抛错记失败且不中断后续钩子', async (t) => {
  const env = createMockEnv();
  await createWebhook(env, { name: 'a', url: 'https://hooks.example.com/a', events: ['*'] });
  await createWebhook(env, { name: 'b', url: 'https://hooks.example.com/b', events: ['*'] });

  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('/a')) throw new Error('network down');
    return new Response('ok', { status: 200 });
  });

  const result = await dispatchWebhooks(env, { action: 'backup.create' });
  assert.deepEqual(result, { sent: 1, failed: 1 });

  const stored = await listWebhooks(env);
  const byName = Object.fromEntries(stored.map((item) => [item.name, item]));
  assert.match(byName.a.lastError, /network down/);
  assert.equal(byName.b.lastStatus, 200);
});

test('dispatchWebhooks：空 action 直接返回，不读 KV 不发请求', async (t) => {
  const env = createMockEnv();
  await createWebhook(env, { name: 'a', url: 'https://hooks.example.com/a' });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('ok', { status: 200 }));
  assert.deepEqual(await dispatchWebhooks(env, {}), { sent: 0, failed: 0 });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('testWebhook：不存在的 id 报错；成功投递后回写簿记', async (t) => {
  const env = createMockEnv();
  const hook = await createWebhook(env, { name: 't', url: 'https://hooks.example.com/t', secret: 't0ken' });
  await assert.rejects(() => testWebhook(env, 'no-such-id'), /Webhook not found/);

  t.mock.method(globalThis, 'fetch', async () => new Response('ok', { status: 200 }));
  const result = await testWebhook(env, hook.id);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);

  const stored = await listWebhooks(env);
  assert.equal(stored[0].lastStatus, 200);
  assert.ok(stored[0].lastTriggeredAt, '测试投递应记录触发时间');
});
