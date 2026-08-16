import { test } from 'node:test';
import assert from 'node:assert/strict';
// 候选 2：aiService 租户 runner 收编——设置门/extractJsonArray 抽取/回退 envelope、
// updateAiSettings merge+persist、chat 统计分支复用 aiLocalLogic 词汇。
import {
  analyzeNoTagSites,
  chatWithAiAssistant,
  suggestTagMerges,
  updateAiSettings,
} from '../src/services/aiService.js';
import { extractJsonArray, formatPopularSiteLine } from '../src/services/aiLocalLogic.js';
import { DEFAULT_AI_SETTINGS } from '../src/services/aiModelService.js';

function createMemoryKv() {
  const map = new Map();
  return {
    async get(key) { return map.has(key) ? map.get(key) : null; },
    async put(key, value) { map.set(key, String(value)); },
    async delete(key) { map.delete(key); },
    async list() { return [...map.keys()].map((name) => ({ name })); },
  };
}

/**
 * 内存版 D1 mock：settings 表读写 + 标签列表/无标签分析/统计排行 SQL 按子串分发。
 * 未命中的 SQL（可见性谓词、最近活跃、分类热度等）返回空结果；
 * prepare 支持免 bind 直接 all()/first()（与真实 D1 用法一致）。
 */
function createMockEnv({ settings = {}, tagRows = [], topSites = [], noTagSites = [] } = {}) {
  const store = new Map(Object.entries(settings));
  const writes = [];

  function handle(sql, binds) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT value FROM settings WHERE key = ?')) {
      return { row: store.has(binds[0]) ? { value: store.get(binds[0]) } : null };
    }
    if (s.startsWith('SELECT key, value FROM settings')) {
      const prefix = String(binds[0] || '').replace(/%$/, '');
      return { rows: [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
    }
    if (s.startsWith('INSERT INTO settings')) {
      writes.push({ key: binds[0], value: binds[1] });
      store.set(binds[0], binds[1]);
      return { meta: { changes: 1 } };
    }
    if (s.includes('FROM tags t')) return { rows: tagRows };
    if (s.includes('st.tag_id IS NULL')) {
      if (s.includes('COUNT(*) as cnt')) return { row: { cnt: noTagSites.length } };
      return { rows: noTagSites };
    }
    if (s.includes('WHERE COALESCE(s.hits, 0) > 0')) return { rows: topSites };
    if (s.includes('COUNT(*) AS total_sites')) {
      return { row: { total_sites: topSites.length, total_hits: 0, never_visited: 0, stale_30d: 0 } };
    }
    if (s.includes('FROM site_tags st JOIN tags t')) return { rows: [] };
    return { rows: [] };
  }

  function makeStatement(sql, binds = []) {
    return {
      bind(...nextBinds) { return makeStatement(sql, nextBinds); },
      async all() { const out = handle(sql, binds); return { results: out.rows ?? [] }; },
      async first() { const out = handle(sql, binds); return out.row !== undefined ? out.row : (out.rows?.[0] ?? null); },
      async run() { const out = handle(sql, binds); return { success: true, meta: out.meta ?? { changes: 0 } }; },
    };
  }

  const navDb = {
    prepare(sql) {
      return makeStatement(sql);
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements || []) out.push(await stmt.run());
      return out;
    },
  };

  return { env: { NAV_DB: navDb, NAV_AUTH: createMemoryKv() }, store, writes };
}

/** OpenAI 兼容端点 mock：记录请求以便断言租户覆写 systemPrompt 与携带密钥。 */
function mockAiFetch(t, content, calls = []) {
  return t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  });
}

test('suggestTagMerges：AI 未启用时返回本地回退且 mode 为 local，不发起模型请求', async (t) => {
  const { env } = createMockEnv({
    settings: { 'ai.enabled': 'false' },
    tagRows: [
      { id: 1, name: 'AI', site_count: 3 },
      { id: 2, name: '人工智能', site_count: 1 },
    ],
  });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('开关关闭时不应调用模型'); });

  const data = await suggestTagMerges(env);

  assert.equal(data.mode, 'local', '开关关时应为本地模式');
  assert.equal(data.configured, false, '未配置时 configured 为 false');
  assert.equal(data.message, 'AI 未启用或标签数量不足，已返回本地规则合并建议。');
  assert.deepEqual(data.suggestions, [{
    source: '人工智能',
    target: 'AI',
    reason: '常见同义标签，建议合并到使用更多的主标签',
    confidence: 82,
    sourceCount: 1,
    targetCount: 3,
  }], '本地合并建议应来自本地规则');
  assert.equal(fetchMock.mock.callCount(), 0, '开关关闭时不得调用模型');
});

test('suggestTagMerges：开关开且模型返回合法 JSON 数组时解析结果 mode 为 ai', async (t) => {
  const { env } = createMockEnv({
    settings: { 'ai.enabled': 'true', 'ai.apiKey': 'sk-test' },
    tagRows: [
      { id: 1, name: 'AI', site_count: 3 },
      { id: 2, name: '人工智能', site_count: 1 },
    ],
  });
  const content = '[{"source":"AI","target":"人工智能","reason":"同义标签","confidence":90}]';
  const calls = [];
  mockAiFetch(t, content, calls);

  const data = await suggestTagMerges(env);

  assert.equal(data.mode, 'ai', '解析出建议时应为 ai 模式');
  assert.equal(data.configured, true);
  assert.equal(data.raw, content, 'raw 应为模型原文（500 字内不截断）');
  assert.deepEqual(data.suggestions, [{
    source: 'AI',
    target: '人工智能',
    reason: '同义标签',
    confidence: 90,
    sourceCount: 3,
    targetCount: 1,
  }]);
  assert.equal(calls.length, 1, '应恰好调用一次模型');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test', '应携带解密后的 API Key');
  const body = JSON.parse(calls[0].options.body);
  assert.ok(body.messages[0].content.includes('你是标签体系整理助手'), '租户应覆写 systemPrompt');
  assert.ok(body.messages[1].content.includes('- AI（书签数：3）'), '用户消息应包含标签列表');
});

test('suggestTagMerges：模型返回畸形答案时回退 envelope，不向上抛 5xx', async (t) => {
  const { env } = createMockEnv({
    settings: { 'ai.enabled': 'true', 'ai.apiKey': 'sk-test' },
    tagRows: [
      { id: 1, name: 'AI', site_count: 3 },
      { id: 2, name: '人工智能', site_count: 1 },
    ],
  });
  mockAiFetch(t, '抱歉，我无法以 JSON 数组形式回答这个问题。');

  const data = await suggestTagMerges(env);

  assert.equal(data.mode, 'fallback', '解析失败应进入回退模式');
  assert.equal(data.configured, true);
  assert.match(data.message, /AI 标签合并建议失败/);
  assert.equal(data.suggestions.length, 1, '应返回本地规则建议而非抛错');
});

test('chatWithAiAssistant：统计型问题输出与 aiLocalLogic 词汇一致', async (t) => {
  const topSites = [
    { id: 1, name: '站点甲', url: 'https://a.example.com', catelog: '工具', hits: 31 },
    { id: 2, name: '站点乙', url: 'https://b.example.com', catelog: '', hits: 12 },
  ];
  const { env } = createMockEnv({ topSites });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('统计分支不应调用模型'); });

  const { code, data } = await chatWithAiAssistant(env, {
    message: '本站访问最多的书签有哪些',
    access: { adminAuthed: true },
  });

  assert.equal(code, 200);
  assert.equal(data.mode, 'local_strict');
  assert.equal(data.configured, false);
  const expected = `以下是本站访问量最高的 2 个书签：\n\n${topSites.map((site, i) => formatPopularSiteLine(site, i)).join('\n\n')}`;
  assert.equal(data.answer, expected, '回答应由 aiLocalLogic.formatPopularSiteLine 逐字生成');
  assert.ok(data.answer.includes('（未分类）— 累计访问 12 次'), '空分类应回退为“未分类”词汇');
  assert.equal(data.sites.length, 2);
  assert.equal(fetchMock.mock.callCount(), 0, '统计分支命中排行后不应调用模型');
});

test('updateAiSettings：与已存设置合并——缺省继承已存值、cleanText 清洗、bool 强制归一、星号不写回', async () => {
  const { env, writes } = createMockEnv({
    settings: {
      'ai.enabled': 'true',
      'ai.enableThinking': 'true',
      'ai.apiKey': 'sk-old',
      'ai.baseUrl': 'https://saved.example.com/v1/chat/completions',
      'ai.model': 'saved-model',
      'ai.systemPrompt': '已存提示词',
    },
  });

  const data = await updateAiSettings(env, { model: '  new-model  ', apiKey: '********' });

  const writeMap = new Map(writes.map((w) => [w.key, w.value]));
  assert.equal(writeMap.get('ai.enabled'), 'false', 'bool 缺省保持既有强制归一为 false');
  assert.equal(writeMap.get('ai.enableThinking'), 'false', 'bool 缺省保持既有强制归一为 false');
  assert.equal(writeMap.get('ai.baseUrl'), 'https://saved.example.com/v1/chat/completions', '缺省字段应继承已存值而非默认值');
  assert.equal(writeMap.get('ai.model'), 'new-model', 'cleanText 应清洗首尾空白');
  assert.equal(writeMap.get('ai.systemPrompt'), '已存提示词', '缺省字段应继承已存值');
  assert.ok(!writeMap.has('ai.apiKey'), '星号占位不得写回 apiKey');
  assert.equal(data.model, 'new-model');
  assert.equal(data.apiKey, '********', '已配置密钥对外保持星号掩码');
  assert.equal(data.configured, true);
});

test('updateAiSettings：空库首写走默认回退，新密钥落库（无主密钥时原文）', async () => {
  const { env, writes } = createMockEnv();

  const data = await updateAiSettings(env, {
    enabled: true,
    apiKey: 'sk-new',
    baseUrl: '  https://x.example.com/v1/chat/completions  ',
  });

  const writeMap = new Map(writes.map((w) => [w.key, w.value]));
  assert.equal(writeMap.get('ai.enabled'), 'true', '布尔 true 归一为字符串 true');
  assert.equal(writeMap.get('ai.enableThinking'), 'false');
  assert.equal(writeMap.get('ai.baseUrl'), 'https://x.example.com/v1/chat/completions', 'cleanText 清洗 URL');
  assert.equal(writeMap.get('ai.model'), DEFAULT_AI_SETTINGS.model, '无已存值时缺省回退默认模型');
  assert.equal(writeMap.get('ai.systemPrompt'), DEFAULT_AI_SETTINGS.systemPrompt, '无已存值时缺省回退默认提示词');
  assert.equal(writeMap.get('ai.apiKey'), 'sk-new', '无 SECRET_KEY 时加密为 no-op，原文落库');
  assert.equal(data.apiKey, '********', '返回值中密钥保持掩码');
  assert.equal(data.configured, true);
});

test('extractJsonArray：空串、无数组文本与非法 JSON 均抛错', () => {
  assert.throws(() => extractJsonArray(''), /JSON/, '空串应抛 JSON 解析错误');
  assert.throws(() => extractJsonArray('这里没有任何方括号'), /JSON/, '无数组时整体 parse 失败应抛错');
  assert.throws(() => extractJsonArray('结果 [1, 2, } 完毕'), /JSON/, '括号内非法 JSON 应抛错');
});

test('extractJsonArray：合法数组、前后缀文本、嵌套方括号均可解析', () => {
  assert.deepEqual(extractJsonArray('[1, 2, 3]'), [1, 2, 3]);
  assert.deepEqual(
    extractJsonArray('建议如下：[{"source":"A","target":"B"}]，请确认。'),
    [{ source: 'A', target: 'B' }],
    '应截取方括号片段而非整体解析',
  );
  assert.deepEqual(extractJsonArray('嵌套 [[1,2],[3]] 数组'), [[1, 2], [3]], '贪婪匹配应取最外层方括号');
  assert.equal(extractJsonArray('{"not":"array"}'), null, '解析成功但非数组返回 null');
});

test('analyzeNoTagSites：模型返回合法数组时逐项映射，空标签与越界序号被过滤', async (t) => {
  const noTagSites = [
    { id: 11, name: '无标签甲', url: 'https://11.example.com', desc: '', catelog: '工具', visibility: 'public' },
    { id: 12, name: '无标签乙', url: 'https://12.example.com', desc: '', catelog: '知识', visibility: 'public' },
  ];
  const { env } = createMockEnv({
    settings: { 'ai.enabled': 'true', 'ai.apiKey': 'sk-test' },
    noTagSites,
  });
  mockAiFetch(t, '[{"id":1,"tags":[" 工具 "," 效率 "]},{"id":1,"tags":[]},{"id":9,"tags":["越界"]}]');

  const data = await analyzeNoTagSites(env);

  assert.equal(data.type, 'no-tags');
  assert.equal(data.aiEnabled, true);
  assert.equal(data.total, 2);
  assert.deepEqual(data.sites.map((s) => s.id), [11, 12]);
  assert.deepEqual(data.suggestions, [
    { siteId: 11, siteName: '无标签甲', tags: ['工具', '效率'] },
  ], '应 cleanText 清洗标签、剔除空标签与越界序号');
});

test('analyzeNoTagSites：模型畸形答案静默回退空建议，不抛 5xx', async (t) => {
  const { env } = createMockEnv({
    settings: { 'ai.enabled': 'true', 'ai.apiKey': 'sk-test' },
    noTagSites: [{ id: 11, name: '无标签甲', url: 'https://11.example.com', desc: '', catelog: '工具', visibility: 'public' }],
  });
  mockAiFetch(t, '抱歉，无法完成该分析任务。');

  const data = await analyzeNoTagSites(env);

  assert.equal(data.aiEnabled, true);
  assert.deepEqual(data.suggestions, [], '畸形答案应回退为空建议而非抛错');
});
