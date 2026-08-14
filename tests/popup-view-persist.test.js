import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 源码级回归断言：popup.js 的视图持久化（saveBrowseView/restoreBrowseView）是
// DOM 层逻辑（依赖 localStorage + browseState），无运行 seam 可测，改用源码断言
// 锁定两个会复发的 bug 模式：
// 1. 分类/搜索/排序切换不保存视图 → 关闭再打开恢复旧分类（已修复：统一在
//    applyBrowseView 保存；此断言防未来有人把 save 从 applyBrowseView 移走）
// 2. restore 误写回 localStorage → 恢复动作污染已保存视图
const popupSrc = readFileSync(
  fileURLToPath(new URL('../extensions/browser-bookmark/popup.js', import.meta.url)),
  'utf8',
);

test('视图持久化：applyBrowseView 统一调用 saveBrowseView', () => {
  const match = popupSrc.match(/function applyBrowseView\([\s\S]*?\n}/);
  assert.ok(match, '应存在 applyBrowseView 定义');
  // 行首断言：排除注释行（//saveBrowseView(); 也会子串匹配，会恒绿）
  assert.match(match[0], /^\s+saveBrowseView\(\);/m, '分类/搜索/排序切换都经 applyBrowseView，必须在此统一保存视图');
});

test('视图持久化：saveBrowseView 保存 catelog/keyword/sort 三字段', () => {
  const match = popupSrc.match(/function saveBrowseView\(\)[\s\S]*?\n}/);
  assert.ok(match, '应存在 saveBrowseView 定义');
  assert.match(match[0], /catelog:/);
  assert.match(match[0], /keyword:/);
  assert.match(match[0], /sort:/);
});

test('视图持久化：restoreBrowseView 只读不写，防止恢复时污染已保存视图', () => {
  const match = popupSrc.match(/function restoreBrowseView\(\)[\s\S]*?\n}/);
  assert.ok(match, '应存在 restoreBrowseView 定义');
  assert.doesNotMatch(match[0], /setItem/, 'restore 不应写 localStorage（否则恢复动作会覆盖上次保存的视图）');
});
