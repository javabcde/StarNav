import test from 'node:test';
import assert from 'node:assert/strict';

// C7 抽取：AI 本地纯逻辑（意图识别/关键词推断/本地回退建议）独立成可测模块。
import {
  buildLocalAnswer,
  detectBookmarkIntent,
  filterSitesByContainsKeyword,
  inferSearchKeywords,
  normalizeCategorySuggestion,
  normalizeTagMergeSuggestions,
  parseSuggestedCategory,
  parseSuggestedTags,
  suggestCategoryLocally,
  suggestTagMergesLocally,
  suggestTagsLocally,
} from '../src/services/aiLocalLogic.js';

test('detectBookmarkIntent：排行/分类/URL/存在/列表/包含六类意图', () => {
  const popular = detectBookmarkIntent('访问最多的书签有哪些');
  assert.equal(popular.asksPopular, true);
  assert.equal(popular.popularLimit, 5, '未给数字时默认 5');
  assert.equal(detectBookmarkIntent('top 10 书签').popularLimit, 10);

  assert.equal(detectBookmarkIntent('这个网站在哪个分类').asksCategory, true);
  assert.equal(detectBookmarkIntent('它的链接是什么').asksUrl, true);
  assert.equal(detectBookmarkIntent('本站有没有图床网站').asksExistence, true);
  assert.equal(detectBookmarkIntent('列出所有云盘').asksList, true);
  assert.equal(detectBookmarkIntent('包含"云"字的书签').containsKeyword, '云');
  assert.equal(detectBookmarkIntent('包含A字').containsKeyword, 'A', '单字关键词按原文捕获');
  assert.equal(detectBookmarkIntent('它在哪里').hasPronoun, true);
});

test('inferSearchKeywords：噪声剥离、引号、URL、查询扩展（图床组）', () => {
  const keywords = inferSearchKeywords('帮我找一个图床网站');
  assert.ok(keywords.includes('图床'), '核心词应命中');
  assert.ok(keywords.some((k) => ['上传图片', '图片上传', '图片外链'].includes(k)), '查询扩展应展开同义组');
  assert.ok(!keywords.some((k) => k === '帮我' || k === '找' || k === '网站'), '停用词不应进入关键词');

  const quoted = inferSearchKeywords('找包含"AI 工具"的书签');
  assert.ok(quoted.includes('AI 工具'), '引号内容应作为关键词');
});

test('filterSitesByContainsKeyword：按字段包含过滤', () => {
  const sites = [
    { name: '百度网盘', tags: ['云盘'] },
    { name: 'GitHub', desc: '代码托管' },
  ];
  const filtered = filterSitesByContainsKeyword(sites, '网盘');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].name, '百度网盘');
  assert.equal(filterSitesByContainsKeyword(sites, '').length, 2, '空关键词不过滤');
});

test('buildLocalAnswer：空结果与分类/URL/列表意图的中文回退文案', () => {
  const empty = buildLocalAnswer('图床', []);
  assert.match(empty.answer, /没有在本站书签中找到/);
  assert.equal(empty.mode, 'local');

  const sites = [{ name: '路过图床', catelog: '图床', url: 'https://img.example.com' }];
  assert.match(buildLocalAnswer('在哪个分类', sites).answer, /位于“图床”分类/);
  assert.match(buildLocalAnswer('链接是什么', sites).answer, /https:\/\/img\.example\.com/);
  assert.match(buildLocalAnswer('包含"图"字', sites).answer, /包含“图”的/);
});

test('suggestTagsLocally：规则命中与现有标签合并', () => {
  const tags = suggestTagsLocally({ name: 'xx图床', url: 'https://img.example.com', catelog: '工具', desc: '' });
  assert.ok(tags.includes('图床'), 'img 命中图床规则');
  assert.ok(tags.includes('工具'), 'catelog 作为候选标签');

  const merged = suggestTagsLocally({ name: 'AI 助手', url: '', catelog: 'AI', desc: 'gpt 驱动' }, [{ name: '助手' }]);
  assert.ok(merged.includes('AI'));
  assert.ok(merged.includes('助手'), '与站点文本匹配的现有标签应并入');
});

test('parseSuggestedTags：JSON 数组与逗号分隔文本', () => {
  assert.deepEqual(parseSuggestedTags('["AI", "工具", "AI"]', 8), ['AI', '工具']);
  assert.deepEqual(parseSuggestedTags('#AI, #工具、云盘', 8), ['AI', '工具', '云盘']);
  assert.deepEqual(parseSuggestedTags('', 8), []);
});

test('suggestCategoryLocally / normalizeCategorySuggestion / parseSuggestedCategory：规则与模糊匹配', () => {
  const categories = [{ name: 'AI' }, { name: '工具' }];
  assert.equal(suggestCategoryLocally({ name: 'ChatGPT 助手', url: '' }, categories), 'AI');
  assert.equal(normalizeCategorySuggestion('ai', categories), 'AI', '忽略大小写命中');
  assert.equal(parseSuggestedCategory('工具', categories), '工具');
});

test('suggestTagMergesLocally：同义别名与空白差异合并建议', () => {
  const tags = [
    { name: 'AI', site_count: 12 },
    { name: '人工智能', site_count: 3 },
    { name: 'Web 工具', site_count: 5 },
    { name: 'web工具', site_count: 2 },
  ];
  const suggestions = suggestTagMergesLocally(tags, 8);
  assert.ok(suggestions.some((s) => s.source === '人工智能' && s.target === 'AI'), '别名应合并到使用更多的主标签');
  assert.ok(suggestions.some((s) => s.source === 'web工具' && s.target === 'Web 工具'), '空白差异应建议统一');
});

test('normalizeTagMergeSuggestions：AI 建议按现有标签白名单过滤', () => {
  const tags = [{ name: 'AI', site_count: 1 }, { name: '人工智能', site_count: 1 }];
  const items = [
    { source: 'AI', target: '人工智能', reason: '同义', confidence: 90 },
    { source: '不存在的标签', target: 'AI', reason: 'x', confidence: 90 },
  ];
  const result = normalizeTagMergeSuggestions(items, tags, 8);
  assert.equal(result.length, 1);
  assert.equal(result[0].source, 'AI');
  assert.equal(result[0].target, '人工智能');
});
