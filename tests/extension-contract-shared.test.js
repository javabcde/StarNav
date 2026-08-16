// 扩展契约共享帮助函数测试 + 壳层漂移回归锁（2026-08-16 架构评审候选 7）：
// escapeHTML 与 normalizeBaseUrl 单一持有在 extension-contract.js；
// popup.js 壳不得再定义本地副本（源码级断言，同仓库既有回归锁先例）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const EXT = new URL('../extensions/browser-bookmark/', import.meta.url);

function loadContract() {
  vm.runInThisContext(readFileSync(new URL('extension-contract.js', EXT), 'utf8'));
  return globalThis.Contract;
}

const Contract = loadContract();

test('Contract.escapeHTML：五种字符全部转义，空值回退空串', () => {
  assert.equal(Contract.escapeHTML('<a href="x" onclick=\'y\'>&</a>'), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(Contract.escapeHTML(undefined), '');
  assert.equal(Contract.escapeHTML(null), '');
});

test('Contract.normalizeBaseUrl：去尾斜杠与首尾空白', () => {
  assert.equal(Contract.normalizeBaseUrl(' https://example.com/ '), 'https://example.com');
  assert.equal(Contract.normalizeBaseUrl(''), '');
});

test('壳层漂移回归锁：popup.js 不再自带 normalizeBaseUrl/escapeHTML 副本', () => {
  const popupSource = readFileSync(new URL('popup.js', EXT), 'utf8');
  assert.ok(popupSource.includes('Contract.normalizeBaseUrl'), 'popup.js 应经 Contract 取 normalizeBaseUrl');
  assert.ok(popupSource.includes('escapeHTML: Contract.escapeHTML'), 'popup.js 应经 Contract 取 escapeHTML');
  assert.ok(!/function normalizeBaseUrl/.test(popupSource), 'popup.js 不得再定义 normalizeBaseUrl 副本');
  assert.ok(!/function escapeHTML/.test(popupSource), 'popup.js 不得再定义 escapeHTML 副本');
});
