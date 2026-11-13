import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// omnibox-logic.js 是 UMD（浏览器经典 script 挂 globalThis.OmniboxLogic）。
// 仓库根 package.json 为 "type": "module"，直接 import/require 会被按 ESM 解析
// 导致 module 未定义、UMD 走全局分支无导出；用 vm 在当前 realm 执行真实文件。
// 先加载契约（escapeHTML 单一源），加载顺序与 background.js 的 importScripts 一致。
const contractSource = readFileSync(new URL('../extensions/browser-bookmark/extension-contract.js', import.meta.url), 'utf8');
vm.runInThisContext(contractSource);
const logicSource = readFileSync(new URL('../extensions/browser-bookmark/omnibox-logic.js', import.meta.url), 'utf8');
vm.runInThisContext(logicSource);
const OmniboxLogic = globalThis.OmniboxLogic;

const {
  isSafeNavUrl,
  searchOmniboxItems,
  buildOmniboxSuggestions,
  normalizeOmniboxTarget,
  renderDefaultSuggestion,
} = OmniboxLogic;

function site(overrides = {}) {
  return {
    id: 1,
    name: 'GitHub',
    url: 'https://github.com',
    catelog: '开发工具',
    tags: [],
    hits: 0,
    ...overrides,
  };
}

test('isSafeNavUrl：仅 http/https 进入地址栏导航', () => {
  assert.equal(isSafeNavUrl('https://github.com'), true);
  assert.equal(isSafeNavUrl('HTTP://example.com'), true);
  assert.equal(isSafeNavUrl('javascript:alert(1)'), false);
  assert.equal(isSafeNavUrl('data:text/html,x'), false);
  assert.equal(isSafeNavUrl('ftp://example.com'), false);
  assert.equal(isSafeNavUrl(''), false);
});

test('searchOmniboxItems：匹配优先级 名称精确 > 前缀 > 包含 > 标签，hits 兜底', () => {
  const items = [
    site({ id: 1, name: 'GitHub', url: 'https://github.com', hits: 10 }),
    site({ id: 2, name: 'GitHub Trending', url: 'https://github.com/trending', hits: 999 }),
    site({ id: 3, name: '键盘', url: 'https://example.com/keyboard', catelog: '工具', tags: ['github'] }),
    site({ id: 4, name: 'Git 教程', url: 'https://git-scm.com/book', catelog: '学习' }),
  ];
  const found = searchOmniboxItems(items, 'GitHub');
  assert.deepEqual(found.map((item) => item.id), [1, 2, 3], '名称精确 > 前缀 > 标签；hits 不越级');
});

test('searchOmniboxItems：多词必须全部命中（跨字段）', () => {
  const items = [
    site({ id: 1, name: 'GitHub', url: 'https://github.com' }),
    site({ id: 2, name: 'Git 教程', url: 'https://git-scm.com/book' }),
    site({ id: 3, name: 'HubSpot', url: 'https://hubspot.com' }),
  ];
  const found = searchOmniboxItems(items, 'git hub');
  assert.deepEqual(found.map((item) => item.id), [1], 'Git 教程缺 hub、HubSpot 缺 git，均不命中');
});

test('searchOmniboxItems：URL / 分类 / 标签均可命中，且大小写不敏感', () => {
  const items = [
    site({ id: 1, name: 'A', url: 'https://example.com/react' }),
    site({ id: 2, name: 'B', url: 'https://b.com', catelog: 'React 生态' }),
    site({ id: 3, name: 'C', url: 'https://c.com', catelog: '其他', tags: ['React'] }),
  ];
  assert.deepEqual(searchOmniboxItems(items, 'REACT').map((item) => item.id), [1, 2, 3], 'URL > 分类 > 标签');
});

test('searchOmniboxItems：同 URL 去重、非 http(s) 排除、limit 生效', () => {
  const items = [
    site({ id: 1, name: 'GitHub 主', url: 'https://github.com', hits: 50 }),
    site({ id: 2, name: 'GitHub 副本', url: 'https://github.com', hits: 10 }),
    site({ id: 3, name: 'GitHub 恶意', url: 'javascript:alert(1)' }),
    site({ id: 4, name: 'GitHub 文档', url: 'https://docs.github.com', hits: 1 }),
    site({ id: 5, name: 'GitHub 博客', url: 'https://github.blog', hits: 30 }),
  ];
  assert.deepEqual(searchOmniboxItems(items, 'github').map((item) => item.id), [1, 5, 4]);
  assert.deepEqual(searchOmniboxItems(items, 'github', 2).map((item) => item.id), [1, 5]);
  assert.deepEqual(searchOmniboxItems(items, '   '), [], '空关键词不返回候选');
  assert.deepEqual(searchOmniboxItems(null, 'github'), [], '非法 items 输入安全返回空');
});

test('buildOmniboxSuggestions：content 为导航 URL，描述含高亮/URL/分类且完成 XML 转义', () => {
  const [suggestion] = buildOmniboxSuggestions([
    site({ name: 'A & B <GitHub>', url: 'https://github.com/a?x=1&y=2', catelog: '开发 & 工具', tags: ['Git', 'Hub'] }),
  ], 'github');
  assert.equal(suggestion.content, 'https://github.com/a?x=1&y=2');
  assert.match(suggestion.description, /<match>GitHub<\/match>/, '命中的关键词用 <match> 包裹');
  assert.match(suggestion.description, /A &amp; B &lt;(?:<match>GitHub<\/match>)&gt;/, '名称中的 XML 保留字符已转义');
  assert.match(suggestion.description, /<url>https:\/\/github\.com\/a\?x=1&amp;y=2<\/url>/, 'URL 灰显且 & 转义');
  assert.match(suggestion.description, /<dim>开发 &amp; 工具 · Git · Hub<\/dim>/, '分类与标签进 <dim>');
});

test('buildOmniboxSuggestions：过滤非 http(s) 候选', () => {
  const suggestions = buildOmniboxSuggestions([
    site({ name: 'JS 伪协议', url: 'javascript:alert(1)' }),
    site({ name: '正常', url: 'https://ok.example.com' }),
  ], '');
  assert.deepEqual(suggestions.map((item) => item.content), ['https://ok.example.com']);
});

test('normalizeOmniboxTarget：完整 URL / 裸域名 / 关键词分流', () => {
  assert.deepEqual(normalizeOmniboxTarget('https://github.com/a'), { kind: 'url', url: 'https://github.com/a' });
  assert.deepEqual(normalizeOmniboxTarget('HTTP://example.com'), { kind: 'url', url: 'HTTP://example.com' });
  assert.deepEqual(normalizeOmniboxTarget('example.com/path?q=1'), { kind: 'url', url: 'https://example.com/path?q=1' });
  assert.deepEqual(normalizeOmniboxTarget('sub.example.co.uk:8080/x'), { kind: 'url', url: 'https://sub.example.co.uk:8080/x' });
  assert.deepEqual(normalizeOmniboxTarget('react hooks'), { kind: 'search', value: 'react hooks' });
  assert.deepEqual(normalizeOmniboxTarget('本地书签'), { kind: 'search', value: '本地书签' });
  assert.deepEqual(normalizeOmniboxTarget('javascript:alert(1)'), { kind: 'search', value: 'javascript:alert(1)' });
  assert.deepEqual(normalizeOmniboxTarget('ftp://example.com'), { kind: 'search', value: 'ftp://example.com' });
  assert.deepEqual(normalizeOmniboxTarget('   '), { kind: 'search', value: '' });
});

test('renderDefaultSuggestion：未配置 / 空输入 / 命中 / 无匹配 / 加载中，且转义关键词', () => {
  assert.equal(renderDefaultSuggestion({ configured: false, query: 'x' }), '请先在插件选项中配置 StarNav 地址与 Token');
  assert.match(renderDefaultSuggestion({ configured: true, total: 12 }), /共 12 条/);
  assert.match(renderDefaultSuggestion({ configured: true, query: 'github', matched: 3 }), /搜索「github」/);
  assert.match(renderDefaultSuggestion({ configured: true, query: 'nope', matched: 0 }), /没有匹配「nope」/);
  assert.match(renderDefaultSuggestion({ configured: true, query: 'github', loading: true }), /正在加载/);
  assert.equal(
    renderDefaultSuggestion({ configured: true, query: '<script>', matched: 0 }),
    '没有匹配「&lt;script&gt;」的收藏，回车打开 StarNav 首页',
  );
});
