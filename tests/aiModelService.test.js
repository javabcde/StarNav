import test from 'node:test';
import assert from 'node:assert/strict';

// C7 抽取：AI 模型调用管道（端点推导、OpenAI 兼容调用、载荷归一化）。
import {
  callOpenAiCompatible,
  DEFAULT_AI_SETTINGS,
  getModelsEndpoint,
  normalizeAiSettingsPayload,
} from '../src/services/aiModelService.js';

test('getModelsEndpoint：chat/completions 端点映射为 models，无后缀则追加', () => {
  assert.equal(getModelsEndpoint('https://api.openai.com/v1/chat/completions'), 'https://api.openai.com/v1/models');
  assert.equal(getModelsEndpoint('https://api.siliconflow.cn/v1/responses'), 'https://api.siliconflow.cn/v1/models');
  assert.equal(getModelsEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/models');
});

test('normalizeAiSettingsPayload：缺省并入已存设置，apiKey 星号占位不覆盖', () => {
  const saved = { enabled: 'true', apiKey: 'secret-1', baseUrl: 'https://a.example.com/v1/chat/completions', model: 'gpt-4o', systemPrompt: 'p' };
  const next = normalizeAiSettingsPayload(saved, { apiKey: '********', enabled: true });
  assert.equal(next.apiKey, 'secret-1', '星号占位不应覆盖已存密钥');
  assert.equal(next.enabled, 'true', '布尔 true 归一为字符串 true');
  assert.equal(next.model, 'gpt-4o');
  assert.ok(DEFAULT_AI_SETTINGS.baseUrl, '默认设置应导出');
  // 字符串 'false' 不是布尔 true——既有语义：非布尔真值不覆盖已存设置
  const stringFalse = normalizeAiSettingsPayload(saved, { enabled: 'false' });
  assert.equal(stringFalse.enabled, 'true');
});

test('callOpenAiCompatible：成功响应剥离 Markdown 星号并返回内容', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    choices: [{ message: { content: '**答案** 内容' } }],
  }), { status: 200 }));
  const answer = await callOpenAiCompatible({
    settings: { baseUrl: 'https://x/v1/chat/completions', apiKey: 'k', model: 'm', systemPrompt: 's', enableThinking: 'false' },
    message: 'hi',
    context: '结果',
  });
  assert.equal(answer, '答案 内容');
});

test('callOpenAiCompatible：非 2xx 抛出带状态的错误，空答案抛错', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
  await assert.rejects(
    callOpenAiCompatible({ settings: { baseUrl: 'https://x', apiKey: 'k', model: 'm', systemPrompt: 's', enableThinking: 'false' }, message: 'hi', context: '' }),
    /AI provider error: 500/,
  );

  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));
  await assert.rejects(
    callOpenAiCompatible({ settings: { baseUrl: 'https://x', apiKey: 'k', model: 'm', systemPrompt: 's', enableThinking: 'false' }, message: 'hi', context: '' }),
    /empty answer/,
  );
});
