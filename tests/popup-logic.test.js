import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// popup-logic.js 是 UMD（浏览器经典 script 挂 globalThis.BrowseLogic）。
// 仓库根 package.json 为 "type": "module"，直接 import/require 会被按 ESM 解析
// 导致 module 未定义、UMD 走全局分支无导出；用 vm 在当前 realm 执行真实文件，
// 同时避免沙箱 realm 的 prototype 差异让 deepStrictEqual 误报。
const logicSource = readFileSync(new URL('../extensions/browser-bookmark/popup-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(logicSource);
const BrowseLogic = globalThis.BrowseLogic;

const {
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
