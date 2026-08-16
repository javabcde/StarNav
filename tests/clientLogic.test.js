// 页面客户端纯逻辑（clientLogic.js）单测（2026-08-16 架构评审候选 2）：
// 这些函数经 toString() 生成期内联进首页/后台客户端模板——测试即行为契约。
// 内联契约回归锁：函数体禁止反引号与 ${ 序列（String.raw 输出前提，见 clientScript.js 探针）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeText, highlightText, mergeSearchHistory, normalizeAiText, normalizeClientUrl } from '../src/pages/clientLogic.js';

test('内联契约回归锁：全部导出函数源码不含反引号与 ${，可安全 toString 内联', () => {
  for (const fn of [escapeText, highlightText, mergeSearchHistory, normalizeAiText, normalizeClientUrl]) {
    const source = fn.toString();
    assert.ok(!source.includes('`'), `${fn.name} 源码含反引号，破坏 String.raw 输出前提`);
    assert.ok(!source.includes('${'), `${fn.name} 源码含未插值 \${，破坏模板插值面收敛`);
  }
});

test('escapeText：五种字符全部转义，空值回退空串', () => {
  assert.equal(escapeText('<a href="x" onclick=\'y\'>&</a>'), '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  assert.equal(escapeText(undefined), '');
  assert.equal(escapeText(null), '');
  assert.equal(escapeText('plain'), 'plain');
});

test('normalizeClientUrl：https 透传、裸域名补协议、不可识别空串、去首尾空白', () => {
  assert.equal(normalizeClientUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeClientUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeClientUrl('  www.example.com  '), 'https://www.example.com');
  assert.equal(normalizeClientUrl('not a url'), '');
  assert.equal(normalizeClientUrl(''), '');
  assert.equal(normalizeClientUrl('/relative/path'), '');
});

test('mergeSearchHistory：新词置顶、去重、上限 8 条（trim 属调用方职责）', () => {
  assert.deepEqual(mergeSearchHistory(['a', 'b'], 'a'), ['a', 'b']);
  assert.deepEqual(mergeSearchHistory(['a', 'b'], 'c'), ['c', 'a', 'b']);
  assert.deepEqual(mergeSearchHistory(['1', '2', '3', '4', '5', '6', '7', '8'], '9'), ['9', '1', '2', '3', '4', '5', '6', '7']);
  assert.deepEqual(mergeSearchHistory(['a', 'b'], '  '), ['  ', 'a', 'b']);
});


test('normalizeAiText：剥加粗/下划线、列表符转 ·、折叠多空行、去首尾空白', () => {
  assert.equal(normalizeAiText('**加粗**和__下划线__'), '加粗和下划线');
  assert.equal(normalizeAiText('- 第一项\n* 第二项'), '· 第一项\n· 第二项');
  assert.equal(normalizeAiText('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(normalizeAiText('  文字  '), '文字');
  assert.equal(normalizeAiText(''), '');
});

test('highlightText：先转义再包 mark，关键词含正则特殊字符不抛错', () => {
  assert.equal(highlightText('<b>x</b>', 'x'), '&lt;b&gt;<mark class="rounded bg-amber-100 px-0.5 text-amber-900">x</mark>&lt;/b&gt;');
  assert.equal(highlightText('plain', ''), 'plain');
  assert.equal(highlightText('a+b*c', 'a+b*c'), '<mark class="rounded bg-amber-100 px-0.5 text-amber-900">a+b*c</mark>');
  assert.equal(highlightText('abc', '['), 'abc');
});
