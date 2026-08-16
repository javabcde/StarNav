import test from 'node:test';
import assert from 'node:assert/strict';

// categoryService 纯逻辑测试：分类子孙闭包树遍历（候选 5 收编自 home.js）
// 与分类颜色安全校验（候选 7 收编自 categoryService/home-categories 双正则）。
import { collectCategoryWithDescendants, normalizeCategoryColor } from '../src/services/categoryService.js';

const TREE = [
  { name: '工具', children: [
    { name: '开发', children: [
      { name: '前端', children: [] },
      { name: '后端', children: [] },
    ] },
    { name: '效率', children: [] },
  ] },
  { name: '知识', children: [] },
];

test('collectCategoryWithDescendants：命中父分类返回父 + 全部子孙名', () => {
  const result = collectCategoryWithDescendants(TREE, '工具');
  assert.deepEqual([...result].sort(), ['工具', '开发', '前端', '后端', '效率'].sort());
});

test('collectCategoryWithDescendants：叶子分类只含自身', () => {
  const result = collectCategoryWithDescendants(TREE, '知识');
  assert.deepEqual([...result], ['知识']);
});

test('collectCategoryWithDescendants：未命中返回空 Set（与 getSites 精确匹配兜底协同）', () => {
  const result = collectCategoryWithDescendants(TREE, '不存在的分类');
  assert.equal(result.size, 0);
});

test('collectCategoryWithDescendants：节点缺 children 字段不抛错', () => {
  const ragged = [{ name: 'A' }, { name: 'B', children: [{ name: 'C' }] }];
  assert.deepEqual([...collectCategoryWithDescendants(ragged, 'B')], ['B', 'C']);
});

test('collectCategoryWithDescendants：父自身必须在集合中（渲染兜底精确匹配依赖空集判定）', () => {
  const result = collectCategoryWithDescendants(TREE, '开发');
  assert.equal(result.has('开发'), true);
  assert.equal(result.has('前端'), true);
});

test('normalizeCategoryColor：恶意载荷一律拒绝（引号/尖括号/分号/url/javascript/expression/@import）', () => {
  for (const hostile of [
    'red; background:url(x)',
    '"red"',
    "'red'",
    '<red>',
    'url(javascript:alert(1))',
    'javascript:alert(1)',
    'expression(alert(1))',
    '@import url(x)',
    'red{}',
  ]) {
    assert.equal(normalizeCategoryColor(hostile), null, `应拒绝：${hostile}`);
  }
});

test('normalizeCategoryColor：hex 3/6 位（大小写均可）通过，非标准 hex 拒绝', () => {
  assert.equal(normalizeCategoryColor('#fff'), '#fff');
  assert.equal(normalizeCategoryColor('#a1B2C3'), '#a1B2C3');
  assert.equal(normalizeCategoryColor('#FFF'), '#FFF');
  assert.equal(normalizeCategoryColor('#ffff'), null);
  assert.equal(normalizeCategoryColor('#12g'), null);
});

test('normalizeCategoryColor：rgba/hsla 宽松形态通过（渲染端历史形态保留）', () => {
  assert.equal(normalizeCategoryColor('rgba(255, 0, 0, 0.5)'), 'rgba(255, 0, 0, 0.5)');
  assert.equal(normalizeCategoryColor('rgb(1,2,3)'), 'rgb(1,2,3)');
  assert.equal(normalizeCategoryColor('hsla(120, 50%, 50%, 1)'), 'hsla(120, 50%, 50%, 1)');
  assert.equal(normalizeCategoryColor('hsl(0, 0%, 100%)'), 'hsl(0, 0%, 100%)');
});

test('normalizeCategoryColor：linear-gradient 通过并保留原样', () => {
  assert.equal(normalizeCategoryColor('linear-gradient(45deg, #f00, #00f)'), 'linear-gradient(45deg, #f00, #00f)');
  assert.equal(normalizeCategoryColor('linear-gradient(red, blue)'), 'linear-gradient(red, blue)');
});

test('normalizeCategoryColor：CSS 颜色名通过并统一小写（含此前两套白名单的分歧样本）', () => {
  assert.equal(normalizeCategoryColor('RED'), 'red');
  assert.equal(normalizeCategoryColor('Primary'), 'primary');
  assert.equal(normalizeCategoryColor('lime'), 'lime');
  // 并轨放行样本：categoryService 旧严格白名单拒绝、home 渲染端历史放行的 CSS 颜色名
  assert.equal(normalizeCategoryColor('rebeccapurple'), 'rebeccapurple');
  assert.equal(normalizeCategoryColor('lightcoral'), 'lightcoral');
});

test('normalizeCategoryColor：非颜色值拒绝，空白归一', () => {
  assert.equal(normalizeCategoryColor(''), null);
  assert.equal(normalizeCategoryColor('   '), null);
  assert.equal(normalizeCategoryColor('not a color'), null, '含空格不是颜色名');
  assert.equal(normalizeCategoryColor('123'), null, '数字开头不是颜色名');
  assert.equal(normalizeCategoryColor('  red  '), 'red', '首尾空白应清洗');
});
