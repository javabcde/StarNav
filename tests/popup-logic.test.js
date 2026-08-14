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
  browseSignature,
  isBrowseCacheFresh,
  decideBrowseView,
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
const view = { keyword: '', catelog: '', sort: '' };

// ── 缓存决策矩阵（f731227 契约）─────────────────────────────

test('decideBrowseView：无缓存 → 不渲染（走骨架屏拉取）', () => {
  assert.deepEqual(decideBrowseView(null, view, MINUTES, NOW), { render: false, refresh: false });
  assert.deepEqual(decideBrowseView({}, view, MINUTES, NOW), { render: false, refresh: false });
});

test('decideBrowseView：新鲜 + 同签名 → 渲染且不刷新（零请求）', () => {
  const cache = { fetchedAt: NOW, signature: browseSignature(view), items: [{ id: 1 }] };
  assert.deepEqual(decideBrowseView(cache, view, MINUTES, NOW), { render: true, refresh: false });
});

test('decideBrowseView：新鲜 + 异签名（换视图）→ 渲染 + 后台刷新', () => {
  const otherView = { keyword: '', catelog: '工具', sort: '' };
  const cache = { fetchedAt: NOW, signature: browseSignature(otherView), items: [{ id: 1 }] };
  assert.deepEqual(decideBrowseView(cache, view, MINUTES, NOW), { render: true, refresh: true });
});

test('decideBrowseView：过期（任意签名）→ 渲染 + 后台刷新', () => {
  const stale = NOW - 13 * 3600 * 1000;
  const cache = { fetchedAt: stale, signature: browseSignature(view), items: [{ id: 1 }] };
  assert.deepEqual(decideBrowseView(cache, view, MINUTES, NOW), { render: true, refresh: true });
});

test('decideBrowseView：12h 整边界 → 视为过期（严格小于）', () => {
  const exactly = NOW - 12 * 3600 * 1000;
  const cache = { fetchedAt: exactly, signature: browseSignature(view), items: [{ id: 1 }] };
  assert.equal(isBrowseCacheFresh(cache, MINUTES, NOW), false);
  assert.equal(decideBrowseView(cache, view, MINUTES, NOW).refresh, true);
});

test('decideBrowseView：minutes <= 0（不缓存）→ 总是刷新', () => {
  const cache = { fetchedAt: NOW, signature: browseSignature(view), items: [{ id: 1 }] };
  assert.equal(decideBrowseView(cache, view, 0, NOW).refresh, true);
  assert.equal(isBrowseCacheFresh(cache, 0, NOW), false);
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

  // 只展开 A → 只有 A 组
  let groups = collectCategoryGroups(tree, new Set(['A']), '');
  assert.deepEqual(groups.map((g) => g.name), ['A']);
  assert.deepEqual(groups[0].items.map((i) => i.name), ['a1', 'a2']);

  // 展开 A + B → 两个独立组
  groups = collectCategoryGroups(tree, new Set(['A', 'B']), '');
  assert.deepEqual(groups.map((g) => g.name), ['A', 'B']);
  assert.deepEqual(groups[1].items.map((i) => i.name), ['b1', 'b2']);
  assert.equal(groups[1].items[0].hasChildren, true);
  assert.equal(groups[1].items[0].expanded, false, 'b1 未展开');

  // A + B + 展开 b1 → b1x 进 B 组（level 1）
  groups = collectCategoryGroups(tree, new Set(['A', 'B', 'b1']), '');
  const b1 = groups[1].items[0];
  assert.equal(b1.expanded, true);
  assert.deepEqual(groups[1].items.map((i) => i.name), ['b1', 'b1x', 'b2']);
  assert.equal(groups[1].items[1].level, 1);

  // active 标记
  groups = collectCategoryGroups(tree, new Set(['A']), 'a2');
  assert.equal(groups[0].items[1].active, true);
  assert.equal(groups[0].items[0].active, false);
});

test('browseSignature：视图维度稳定且区分', () => {
  assert.equal(browseSignature({ keyword: '', catelog: '', sort: '' }), '||');
  assert.equal(browseSignature({ keyword: '', catelog: '工具', sort: '' }), '|工具|');
  assert.notEqual(browseSignature({ keyword: 'x', catelog: '', sort: '' }), '||');
});
