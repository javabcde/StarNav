import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 与 popup-logic.test.js 同模式：vm 在当前 realm 执行 UMD 真实文件。
// 本文件测 popup-logic.js 新增的浏览视图状态纯函数组（browse-view-state）：
// 不新增对旧测试文件的任何修改（popup-logic.test.js 保持原样）。
const logicSource = readFileSync(new URL('../extensions/browser-bookmark/popup-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(logicSource);
const BrowseLogic = globalThis.BrowseLogic;

const {
  defaultBrowseView,
  applyBrowseFilter,
  applyBrowsePage,
  deserializeView,
  toggleCategoryInState,
  collapseChangedFilter,
  collectCategoryNames,
} = BrowseLogic;

const FLAT = [
  { name: '前端', level: 1 },
  { name: 'React', level: 2 },
  { name: 'Vue', level: 2 },
  { name: '工具', level: 1 },
];

test('defaultBrowseView：空筛选、空关键词、空排序、第一页、direct 关', () => {
  assert.deepEqual(defaultBrowseView(), { catelog: '', keyword: '', sort: '', page: 1, direct: false });
});

test('applyBrowseFilter：只改传入字段，其余保持，页码重置 1；direct 显式才切换', () => {
  const base = { catelog: '前端', keyword: 'a', sort: 'hot', page: 3, direct: false };
  assert.deepEqual(applyBrowseFilter(base, { catelog: '工具' }), { catelog: '工具', keyword: 'a', sort: 'hot', page: 1, direct: false });
  assert.deepEqual(applyBrowseFilter(base, { keyword: '' }), { catelog: '前端', keyword: '', sort: 'hot', page: 1, direct: false });
  assert.deepEqual(applyBrowseFilter(base, { sort: 'recent' }), { catelog: '前端', keyword: 'a', sort: 'recent', page: 1, direct: false });
  assert.deepEqual(applyBrowseFilter(base, {}), { catelog: '前端', keyword: 'a', sort: 'hot', page: 1, direct: false });
  const direct = applyBrowseFilter(base, { catelog: '工具', direct: true });
  assert.deepEqual(applyBrowseFilter(direct, { keyword: 'x' }), { catelog: '工具', keyword: 'x', sort: 'hot', page: 1, direct: true });
});

test('applyBrowsePage：页码下限 1，非法值回退 1', () => {
  const base = { catelog: '前端', keyword: '', sort: '', page: 1 };
  assert.equal(applyBrowsePage(base, 3).page, 3);
  assert.equal(applyBrowsePage(base, 0).page, 1);
  assert.equal(applyBrowsePage(base, -2).page, 1);
  assert.equal(applyBrowsePage(base, 'abc').page, 1);
  assert.equal(applyBrowsePage(base, 2).catelog, '前端');
});

test('deserializeView：合法 JSON 强转字段 + direct 布尔', () => {
  const view = deserializeView(JSON.stringify({ catelog: '前端', keyword: 'a', sort: 'hot', ts: 123, direct: true }));
  assert.deepEqual(view, { catelog: '前端', keyword: 'a', sort: 'hot', direct: true });
  assert.equal(deserializeView(JSON.stringify({ catelog: 42, keyword: null, sort: undefined })).catelog, '42');
  assert.equal(deserializeView(JSON.stringify({ catelog: '前端', direct: false })).direct, false);
});

test('deserializeView：非法输入回退 null（默认视图）', () => {
  assert.equal(deserializeView(null), null);
  assert.equal(deserializeView(''), null);
  assert.equal(deserializeView('not-json{'), null);
  assert.equal(deserializeView('null'), null);
  assert.equal(deserializeView('"str"'), null);
  assert.equal(deserializeView('[]'), null);
});

test('toggleCategoryInState：展开/手风琴切换/收起置抑制标志', () => {
  // 空 → 展开某父分类：无抑制
  const expanded1 = toggleCategoryInState({ expanded: new Set() }, '前端');
  assert.deepEqual([...expanded1.expanded], ['前端']);
  assert.equal(expanded1.suppressAncestorInjection, false);
  // 手风琴：点另一个父分类 → 换展开对象，无抑制
  const expanded2 = toggleCategoryInState(expanded1, '工具');
  assert.deepEqual([...expanded2.expanded], ['工具']);
  assert.equal(expanded2.suppressAncestorInjection, false);
  // 再点当前展开的 → 收起为空，置抑制标志
  const collapsed = toggleCategoryInState(expanded2, '工具');
  assert.equal(collapsed.expanded.size, 0);
  assert.equal(collapsed.suppressAncestorInjection, true);
  // 抑制后再次展开：标志清除
  const reexpanded = toggleCategoryInState(collapsed, '前端');
  assert.deepEqual([...reexpanded.expanded], ['前端']);
  assert.equal(reexpanded.suppressAncestorInjection, false);
});

test('collapseChangedFilter：收起父分类时筛选在其子孙下 → 改指父分类 + 页码重置', () => {
  const view = { catelog: 'React', page: 3 };
  const changed = collapseChangedFilter(view, '前端', FLAT);
  assert.deepEqual(changed, { catelog: '前端', page: 1 });
});

test('collapseChangedFilter：筛选不在子孙下 / 同名 / 无筛选 → null（不变）', () => {
  assert.equal(collapseChangedFilter({ catelog: '工具', page: 2 }, '前端', FLAT), null);
  assert.equal(collapseChangedFilter({ catelog: '前端', page: 2 }, '前端', FLAT), null);
  assert.equal(collapseChangedFilter({ catelog: '', page: 2 }, '前端', FLAT), null);
  assert.equal(collapseChangedFilter({ catelog: 'React', page: 2 }, '工具', FLAT), null);
});

test('collectCategoryNames：父分类含全部子孙名，叶子仅自身，未知名空集', () => {
  const parent = collectCategoryNames(FLAT, '前端');
  assert.deepEqual([...parent].sort(), ['React', 'Vue', '前端'].sort());
  const leaf = collectCategoryNames(FLAT, 'React');
  assert.deepEqual([...leaf], ['React']);
  assert.equal(collectCategoryNames(FLAT, '不存在').size, 0);
});
