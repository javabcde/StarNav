import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// collect-picker-logic.js 是 UMD（浏览器经典 script 挂 globalThis.PickerLogic）。
// 与 popup-logic.test.js 同加载模式：vm 在当前 realm 执行真实文件。
const logicSource = readFileSync(new URL('../extensions/browser-bookmark/collect-picker-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(logicSource);
const PickerLogic = globalThis.PickerLogic;

const { pickRelevantCategories, resolveDefaultCategory, normalizeFallbackCategories, isCollectCandidate, UNCATEGORIZED } = PickerLogic;

test('pickRelevantCategories：过滤直属书签虚拟节点，保留真实分类', () => {
  const flat = [
    { name: '工具', level: 0 },
    { name: '直属书签', level: 1, direct: true, parent: '工具' },
    { name: '开发', level: 1 },
    { name: 'AI', level: 2 },
  ];
  const result = pickRelevantCategories(flat);
  assert.deepEqual(result, [
    { name: '工具', level: 0 },
    { name: '开发', level: 1 },
    { name: 'AI', level: 2 },
  ]);
});

test('pickRelevantCategories：空/非数组输入返回空数组', () => {
  assert.deepEqual(pickRelevantCategories(null), []);
  assert.deepEqual(pickRelevantCategories(undefined), []);
  assert.deepEqual(pickRelevantCategories([]), []);
});

test('pickRelevantCategories：跳过空名节点', () => {
  const result = pickRelevantCategories([{ name: '', level: 0 }, { name: '   ', level: 0 }, { name: '导航', level: 0 }]);
  assert.deepEqual(result, [{ name: '导航', level: 0 }]);
});

test('resolveDefaultCategory：记忆命中优先于配置', () => {
  const result = resolveDefaultCategory({ remembered: '收藏夹', configured: '默认夹', available: ['默认夹', '收藏夹'] });
  assert.equal(result, '收藏夹');
});

test('resolveDefaultCategory：记忆失效（分类已删）回退配置', () => {
  const result = resolveDefaultCategory({ remembered: '旧夹', configured: '默认夹', available: ['默认夹', '工具'] });
  assert.equal(result, '默认夹');
});

test('resolveDefaultCategory：配置也不在列表回退未分类', () => {
  const result = resolveDefaultCategory({ remembered: '', configured: '已删夹', available: ['工具'] });
  assert.equal(result, UNCATEGORIZED);
});

test('resolveDefaultCategory：全空回退未分类', () => {
  assert.equal(resolveDefaultCategory({ remembered: '', configured: '', available: [] }), UNCATEGORIZED);
  assert.equal(resolveDefaultCategory({}), UNCATEGORIZED);
  assert.equal(resolveDefaultCategory(), UNCATEGORIZED);
});

test('normalizeFallbackCategories：字符串与 {name} 对象混合归一为 level 0', () => {
  const result = normalizeFallbackCategories(['工具', { name: '开发' }, { name: '' }, null, 42]);
  assert.deepEqual(result, [
    { name: '工具', level: 0 },
    { name: '开发', level: 0 },
  ]);
});

test('normalizeFallbackCategories：空/非数组输入返回空数组', () => {
  assert.deepEqual(normalizeFallbackCategories(null), []);
  assert.deepEqual(normalizeFallbackCategories(undefined), []);
});

test('isCollectCandidate：完整候选通过，缺字段/非对象拒绝', () => {
  assert.equal(isCollectCandidate({ url: 'https://a.com', name: 'A', ts: 1 }), true);
  assert.equal(isCollectCandidate({ url: '', name: 'A' }), false);
  assert.equal(isCollectCandidate({ url: 'https://a.com', name: '  ' }), false);
  assert.equal(isCollectCandidate(null), false);
  assert.equal(isCollectCandidate('https://a.com'), false);
});
