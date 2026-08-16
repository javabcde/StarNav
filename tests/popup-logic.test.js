import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// popup-logic.js 是 UMD（浏览器经典 script 挂 globalThis.BrowseLogic）。
// 仓库根 package.json 为 "type": "module"，直接 import/require 会被按 ESM 解析
// 导致 module 未定义、UMD 走全局分支无导出；用 vm 在当前 realm 执行真实文件，
// 同时避免沙箱 realm 的 prototype 差异让 deepStrictEqual 误报。
// fetchFullBrowseCache 依赖全局 Contract（BROWSE_CACHE_DEFAULT_MINUTES）：
// 与 popup.html / background.js importScripts 相同顺序，先加载契约再加载逻辑。
const contractSource = readFileSync(new URL('../extensions/browser-bookmark/extension-contract.js', import.meta.url), 'utf8');
vm.runInThisContext(contractSource);
const logicSource = readFileSync(new URL('../extensions/browser-bookmark/popup-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(logicSource);
const BrowseLogic = globalThis.BrowseLogic;

const {
  fetchFullBrowseCache,
  isFullBrowseCache,
  isBrowseCacheFresh,
  decideBrowseView,
  filterBrowseItems,
  paginateItems,
  browseHasMore,
  toggleCategory,
  injectAncestors,
  ancestorsOf,
  flattenCategoryTree,
  normalizeCategories,
  buildCategoryTree,
  collectCategoryGroups,
} = BrowseLogic;

const MINUTES = 12 * 60; // 12h
const NOW = Date.now();

function fullCache(overrides = {}) {
  return {
    kind: 'full',
    fetchedAt: NOW,
    ttlMinutes: MINUTES,
    items: [{ id: 1, name: 'A' }],
    total: 1,
    categories: [],
    ...overrides,
  };
}

// ── 缓存识别与决策矩阵（全量语义）──────────────────────────

test('isFullBrowseCache：仅 kind==="full" 且 items 为数组', () => {
  assert.equal(isFullBrowseCache(fullCache()), true);
  assert.equal(isFullBrowseCache({ kind: 'full' }), false, '缺 items');
  assert.equal(isFullBrowseCache({ kind: 'full', items: 'x' }), false);
  assert.equal(isFullBrowseCache({ kind: 'legacy', items: [] }), false, '旧格式不算 full');
  assert.equal(isFullBrowseCache({ fetchedAt: NOW, items: [] }), false, '缺 kind 不算 full');
  assert.equal(isFullBrowseCache(null), false);
});

test('decideBrowseView：新格式新鲜 → 渲染且零请求', () => {
  assert.deepEqual(decideBrowseView(fullCache(), MINUTES, NOW), { render: true, refresh: false });
});

test('decideBrowseView：新格式过期 → 渲染 + 后台刷新', () => {
  const cache = fullCache({ fetchedAt: NOW - 13 * 3600 * 1000 });
  assert.deepEqual(decideBrowseView(cache, MINUTES, NOW), { render: true, refresh: true });
});

test('decideBrowseView：无缓存 / 旧格式 → 不渲染（初始化态拉全量重建）', () => {
  assert.deepEqual(decideBrowseView(null, MINUTES, NOW), { render: false, refresh: false });
  // 旧格式（含 signature 的单视图缓存）一律视为无效
  const legacy = { signature: '||', fetchedAt: NOW, items: [{ id: 1 }], total: 1, page: 2 };
  assert.deepEqual(decideBrowseView(legacy, MINUTES, NOW), { render: false, refresh: false });
});

test('decideBrowseView：12h 整边界 → 视为过期（严格小于）', () => {
  const cache = fullCache({ fetchedAt: NOW - 12 * 3600 * 1000 });
  assert.equal(isBrowseCacheFresh(cache, MINUTES, NOW), false);
  assert.equal(decideBrowseView(cache, MINUTES, NOW).refresh, true);
});

test('decideBrowseView：minutes <= 0（不缓存）→ 总是刷新', () => {
  assert.equal(decideBrowseView(fullCache(), 0, NOW).refresh, true);
});

// ── 客户端过滤（filterBrowseItems）────────────────────────

const SITES = [
  { id: 1, name: '星空图床', url: 'https://xktc.example.com', catelog: '图床', hits: 10, last_visit_time: '2026-08-10 10:00:00', create_time: '2026-08-01 10:00:00' },
  { id: 2, name: 'AI 工具箱', url: 'https://ai.example.com', catelog: '工具', hits: 3, last_visit_time: '', create_time: '2026-08-02 10:00:00' },
  { id: 3, name: '前端文档', url: 'https://front.example.com', catelog: '前端', hits: 7, last_visit_time: '2026-08-12 10:00:00', create_time: '2026-08-03 10:00:00' },
];

test('filterBrowseItems：keyword 子串匹配（大小写不敏感，覆盖 name/url/catelog）', () => {
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '图床', catelog: '', sort: '' }, null).map((s) => s.id), [1]);
  assert.deepEqual(filterBrowseItems(SITES, { keyword: 'XKTC', catelog: '', sort: '' }, null).map((s) => s.id), [1], 'URL 大小写不敏感');
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '工具', catelog: '', sort: '' }, null).map((s) => s.id), [2]);
  assert.equal(filterBrowseItems(SITES, { keyword: '不存在的词', catelog: '', sort: '' }, null).length, 0);
  assert.equal(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: '' }, null).length, 3, '空关键词不过滤');
});

test('filterBrowseItems：分类含子孙集合过滤', () => {
  const toolAndKids = new Set(['工具', '图床', '开发', '前端']);
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '工具', sort: '' }, toolAndKids).map((s) => s.id).sort(), [1, 2, 3]);
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '工具', sort: '' }, new Set(['工具'])).map((s) => s.id), [2]);
  assert.equal(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: '' }, null).length, 3, '无分类不过滤');
});

test('filterBrowseItems：排序（hits / last_visit / name / 默认保序）', () => {
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: 'hits' }, null).map((s) => s.id), [1, 3, 2]);
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: 'last_visit' }, null).map((s) => s.id), [3, 1, 2]);
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: 'name' }, null).map((s) => s.id), [2, 3, 1], '名称升序');
  assert.deepEqual(filterBrowseItems(SITES, { keyword: '', catelog: '', sort: '' }, null).map((s) => s.id), [1, 2, 3], '默认保序');
});

test('filterBrowseItems：不修改入参数组', () => {
  const copy = [...SITES];
  filterBrowseItems(SITES, { keyword: 'x', catelog: '', sort: 'hits' }, null);
  assert.deepEqual(SITES, copy);
});

// ── 客户端分页（paginateItems）────────────────────────────

test('paginateItems：切片与边界', () => {
  const items = Array.from({ length: 75 }, (_, i) => i);
  assert.deepEqual(paginateItems(items, 1, 30), items.slice(0, 30));
  assert.deepEqual(paginateItems(items, 3, 30), items.slice(60, 90), '末页越界返回剩余');
  assert.deepEqual(paginateItems(items, 0, 30), items.slice(0, 30), 'page 0 按 1 处理');
  assert.deepEqual(paginateItems(items, 1, 0), items.slice(0, 30), 'pageSize 0 按默认 30');
  assert.deepEqual(paginateItems(items, 99, 30), [], '超范围返回空');
});

test('browseHasMore：按 page×pageSize 判定，不依赖当前页长度', () => {
  // 85 条 pageSize 30：page1/2 有更多，page3 覆盖完（25 条）
  assert.equal(browseHasMore(1, 30, 85), true);
  assert.equal(browseHasMore(2, 30, 85), true);
  assert.equal(browseHasMore(3, 30, 85), false);
  // 40 条：page1 有更多，page2 覆盖完（10 条——若按当前页长度会误判有更多）
  assert.equal(browseHasMore(1, 30, 40), true);
  assert.equal(browseHasMore(2, 30, 40), false);
  // 边界与异常
  assert.equal(browseHasMore(1, 30, 30), false, '正好一页');
  assert.equal(browseHasMore(0, 30, 85), true, 'page 0 按 1');
  assert.equal(browseHasMore(1, 0, 85), true, 'pageSize 0 按 30');
  assert.equal(browseHasMore(1, 30, 0), false, 'total 0');
});

// ── 手风琴状态机（1722632 / 15cf3e8 契约）──────────────────

test('toggleCategory：同一时间只展开一个，点当前展开的收起', () => {
  let expanded = new Set();
  expanded = toggleCategory(expanded, 'A');
  assert.deepEqual([...expanded], ['A']);
  expanded = toggleCategory(expanded, 'B');
  assert.deepEqual([...expanded], ['B'], '点 B 时 A 自动收起');
  expanded = toggleCategory(expanded, 'B');
  assert.equal(expanded.size, 0, '再点当前展开的 B → 收起');
  expanded = toggleCategory(expanded, 'A');
  expanded = toggleCategory(expanded, 'C');
  assert.deepEqual([...expanded], ['C']);
});

test('toggleCategory：不修改入参 Set', () => {
  const original = new Set(['A']);
  toggleCategory(original, 'B');
  assert.deepEqual([...original], ['A'], '入参不被修改');
});

test('injectAncestors：无手动展开时注入祖先链；有手动展开时不注入', () => {
  const flat = [
    { name: '', level: 0 },
    { name: '工具', level: 0 },
    { name: '开发', level: 1 },
    { name: '前端', level: 2 },
  ];
  const injected = injectAncestors(new Set(), '前端', flat);
  assert.deepEqual([...injected].sort(), ['工具', '开发']);
  const withManual = injectAncestors(new Set(['B']), '前端', flat);
  assert.deepEqual([...withManual], ['B'], '手动展开后尊重手风琴，不注入');
});

test('ancestorsOf：收集祖先名（深到浅）', () => {
  const flat = [
    { name: '', level: 0 },
    { name: '工具', level: 0 },
    { name: '图床', level: 1 },
    { name: '开发', level: 1 },
    { name: '前端', level: 2 },
  ];
  assert.deepEqual(ancestorsOf(flat, '前端'), ['开发', '工具']);
  assert.deepEqual(ancestorsOf(flat, '工具'), []);
  assert.deepEqual(ancestorsOf(flat, '不存在'), []);
});

// ── 分类树构建与分组（bb41477 / 166e8ed 契约）──────────────

test('flattenCategoryTree：跳过空名，子分类 level+1', () => {
  const tree = [
    { name: '工具', children: [
      { name: '图床', children: [] },
      { name: '开发', children: [{ name: '前端', children: [] }] },
    ]},
    { name: '', children: [] },
    { name: '私人书签', children: [] },
  ];
  assert.deepEqual(flattenCategoryTree(tree), [
    { name: '工具', level: 0 },
    { name: '图床', level: 1 },
    { name: '开发', level: 1 },
    { name: '前端', level: 2 },
    { name: '私人书签', level: 0 },
  ]);
});

test('normalizeCategories：兼容旧字符串格式与新对象格式', () => {
  assert.deepEqual(normalizeCategories(['工具', ' 图床 ']), [
    { name: '工具', level: 0 },
    { name: '图床', level: 0 },
  ]);
  assert.deepEqual(normalizeCategories([{ name: '工具', level: 1 }]), [{ name: '工具', level: 1 }]);
  assert.deepEqual(normalizeCategories(null), []);
  assert.deepEqual(normalizeCategories(['', '  ']), []);
});

test('buildCategoryTree：栈法构建层级，root 保持顺序', () => {
  const flat = [
    { name: '', level: 0 },
    { name: '工具', level: 0 },
    { name: '图床', level: 1 },
    { name: '开发', level: 1 },
    { name: '前端', level: 2 },
    { name: '私人书签', level: 0 },
  ];
  const tree = buildCategoryTree(flat);
  assert.deepEqual(tree.map((n) => n.name), ['', '工具', '私人书签']);
  const tool = tree[1];
  assert.deepEqual(tool.children.map((c) => c.name), ['图床', '开发']);
  assert.deepEqual(tool.children[1].children.map((c) => c.name), ['前端']);
});

test('collectCategoryGroups：按父分组不混排，嵌套展开进同组', () => {
  const tree = [
    { name: '', children: [] },
    { name: 'A', children: ['a1', 'a2'].map((n) => ({ name: n, children: [] })) },
    { name: 'B', children: [
      { name: 'b1', children: [{ name: 'b1x', children: [] }] },
      { name: 'b2', children: [] },
    ]},
  ];

  let groups = collectCategoryGroups(tree, new Set(['A']), '');
  assert.deepEqual(groups.map((g) => g.name), ['A']);
  assert.deepEqual(groups[0].items.map((i) => i.name), ['a1', 'a2']);

  groups = collectCategoryGroups(tree, new Set(['A', 'B']), '');
  assert.deepEqual(groups.map((g) => g.name), ['A', 'B']);
  assert.deepEqual(groups[1].items.map((i) => i.name), ['b1', 'b2']);
  assert.equal(groups[1].items[0].hasChildren, true);
  assert.equal(groups[1].items[0].expanded, false, 'b1 未展开');

  groups = collectCategoryGroups(tree, new Set(['A', 'B', 'b1']), '');
  const b1 = groups[1].items[0];
  assert.equal(b1.expanded, true);
  assert.deepEqual(groups[1].items.map((i) => i.name), ['b1', 'b1x', 'b2']);
  assert.equal(groups[1].items[1].level, 1);

  groups = collectCategoryGroups(tree, new Set(['A']), 'a2');
  assert.equal(groups[0].items[1].active, true);
  assert.equal(groups[0].items[0].active, false);
});

// ── 全量缓存构建器（fetchFullBrowseCache）─────────────────

const LIST_PATH = '/api/config?all=1';
const TREE_PATH = '/api/categories/tree';

function createApiFetchStub({ listPayload, treePayload } = {}) {
  const calls = [];
  const apiFetch = async (path) => {
    calls.push(path);
    if (path === LIST_PATH) {
      if (listPayload instanceof Error) throw listPayload;
      return typeof listPayload === 'function' ? listPayload() : listPayload;
    }
    if (path === TREE_PATH) {
      if (treePayload instanceof Error) throw treePayload;
      return typeof treePayload === 'function' ? treePayload() : treePayload;
    }
    return { data: [] };
  };
  return { apiFetch, calls };
}

test('fetchFullBrowseCache：并行拉取 config 与 tree，组装 kind==="full" 形状', async () => {
  const items = [{ id: 1, name: 'A', catelog: '工具' }, { id: 2, name: 'B', catelog: '工具' }];
  const tree = [
    { name: '工具', children: [{ name: '前端', children: [] }] },
    { name: '', children: [] },
  ];
  const before = Date.now();
  const { apiFetch, calls } = createApiFetchStub({
    listPayload: { data: items, total: 2 },
    treePayload: { data: tree },
  });

  const cache = await fetchFullBrowseCache(apiFetch, { minutes: 7 });
  const after = Date.now();

  // 调用参数与既有调用点一致：仅 path，两个端点各一次
  assert.deepEqual(calls.sort(), [TREE_PATH, LIST_PATH], '应恰好拉取 config 与 tree 两个端点');
  assert.equal(cache.kind, 'full');
  assert.ok(Array.isArray(cache.items) && cache.items.length === 2, 'items 应为全量书签数组');
  assert.deepEqual(cache.items, items, 'items 应原样保留服务端数据');
  assert.equal(cache.total, 2);
  assert.equal(cache.ttlMinutes, 7, '正常 minutes 原样生效');
  // 分类树展平（跳过空名，子分类 level+1）
  assert.deepEqual(cache.categories, [{ name: '工具', level: 0 }, { name: '前端', level: 1 }]);
  assert.ok(cache.fetchedAt >= before && cache.fetchedAt <= after, 'fetchedAt 应为构建时刻');
  assert.equal(isFullBrowseCache(cache), true, '构建结果应通过形状守卫');
});

test('fetchFullBrowseCache：两个请求并行发起（先挂起 config 也不阻塞 tree 发出）', async () => {
  const calls = [];
  let releaseList;
  const pendingList = new Promise((resolve) => { releaseList = resolve; });
  const promise = fetchFullBrowseCache(async (path) => {
    calls.push(path);
    if (path === LIST_PATH) return pendingList;
    return { data: [] };
  }, { minutes: 7 });

  // await 前（首个微任务前）两个请求均已同步发起
  assert.deepEqual([...calls].sort(), [TREE_PATH, LIST_PATH], 'Promise.all 应并行发起两个拉取');
  releaseList({ data: [{ id: 1 }], total: 1 });
  const cache = await promise;
  assert.equal(cache.total, 1);
});

test('fetchFullBrowseCache：ttlMinutes 归一（0 / 负数 / NaN / undefined 回退默认 5）', async () => {
  const payload = { listPayload: { data: [{ id: 1 }], total: 1 }, treePayload: { data: [] } };
  const DEFAULT = globalThis.Contract.BROWSE_CACHE_DEFAULT_MINUTES;
  assert.equal(DEFAULT, 5, '契约默认值应为 5 分钟');

  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, { minutes: 0 })).ttlMinutes, 0, '0 = 不缓存，原样保留');
  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, { minutes: -3 })).ttlMinutes, DEFAULT, '负数回退默认');
  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, { minutes: NaN })).ttlMinutes, DEFAULT, 'NaN 回退默认');
  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, {})).ttlMinutes, DEFAULT, 'undefined（缺省）回退默认');
  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, { minutes: 'abc' })).ttlMinutes, DEFAULT, '非数字字符串回退默认');
  assert.equal((await fetchFullBrowseCache(createApiFetchStub(payload).apiFetch, { minutes: '10' })).ttlMinutes, 10, '数字字符串按 Number 归一');
});

test('fetchFullBrowseCache：total 兜底（缺失取长度；0 视为无效回退长度；空列表为 0）', async () => {
  const twoItems = [{ id: 1 }, { id: 2 }];
  const mk = (listResult) => createApiFetchStub({ listPayload: listResult, treePayload: { data: [] } }).apiFetch;

  assert.equal((await fetchFullBrowseCache(mk({ data: twoItems }), { minutes: 7 })).total, 2, 'total 缺失 → items.length');
  assert.equal((await fetchFullBrowseCache(mk({ data: twoItems, total: 0 }), { minutes: 7 })).total, 2, 'total=0 → 回退 items.length（既有语义）');
  assert.equal((await fetchFullBrowseCache(mk({ data: [], total: 0 }), { minutes: 7 })).total, 0, '空列表 + total=0 → 0');
  assert.equal((await fetchFullBrowseCache(mk({ data: [] }), { minutes: 7 })).total, 0, 'total 缺失 + 空列表 → 0');
  assert.equal((await fetchFullBrowseCache(mk({ data: twoItems, total: '3' }), { minutes: 7 })).total, 3, '数字字符串 total 归一');
  assert.equal((await fetchFullBrowseCache(mk({ data: twoItems, total: 'x' }), { minutes: 7 })).total, 2, '非法 total → items.length');
});

test('fetchFullBrowseCache：data 非数组与响应缺省兜底为空集合', async () => {
  const cache = await fetchFullBrowseCache(createApiFetchStub({
    listPayload: { data: null, total: 9 },
    treePayload: { noData: true },
  }).apiFetch, { minutes: 7 });
  assert.deepEqual(cache.items, [], 'data 非数组 → items 为空');
  assert.equal(cache.total, 9, 'total=9 为真值 → 原样保留（既有语义：真值 total 权威）');
  assert.deepEqual(cache.categories, [], 'tree 响应缺 data → categories 为空');

  // 既有语义：响应为 null（违反 apiFetch 返回解析后对象的契约）在读取 total 时抛 TypeError
  await assert.rejects(
    () => fetchFullBrowseCache(async () => null, { minutes: 7 }),
    TypeError,
    '响应为 null → 向上抛错（调用方 try/catch 兜底）',
  );
});

test('fetchFullBrowseCache：任一拉取失败即抛错（不吞异常、不构建部分缓存）', async () => {
  const boom = Object.assign(new Error('网络失败'), { status: 500 });
  await assert.rejects(
    fetchFullBrowseCache(createApiFetchStub({ listPayload: boom }).apiFetch, { minutes: 7 }),
    /网络失败/,
    'config 拉取失败应向上抛出',
  );
  await assert.rejects(
    fetchFullBrowseCache(createApiFetchStub({ treePayload: boom }).apiFetch, { minutes: 7 }),
    /网络失败/,
    'tree 拉取失败应向上抛出',
  );
});
