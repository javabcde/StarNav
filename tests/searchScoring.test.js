// 搜索评分叶模块（services/searchScoring.js）直接单测——2026-08-16 架构评审候选 1。
// 与 submissionAnalytics / healthQuery 同构：纯策略零 D1 依赖，行为矩阵直打。
// 此前评分管线私有封装在 siteService 内只能经 mock D1 的 searchSites 间接触达，
// CJK 首字母路径（'xktc' → 星空图床）零测试；本文件补齐并锁定权重语义。
import test from 'node:test';
import assert from 'node:assert/strict';

import { matchesAdvancedFilters, parseSearchQuery, scoreSite } from '../src/services/searchScoring.js';

test('parseSearchQuery：中文按 2/3/4 元组展开 ngram 并保留整词', () => {
  const query = parseSearchQuery('星空图床');
  assert.ok(query.terms.includes('星空图床'), '整词应在 terms');
  assert.ok(query.terms.includes('星空'), '二元组应在 terms');
  assert.ok(query.terms.includes('空图'), '二元组应在 terms');
  assert.ok(query.terms.includes('图床'), '二元组应在 terms');
  assert.ok(query.terms.includes('星空图'), '三元组应在 terms');
  assert.ok(query.terms.includes('空图床'), '三元组应在 terms');
  assert.ok(query.terms.includes('星空图床'), '四元组应在 terms');
  assert.equal(query.raw, '星空图床');
  assert.deepEqual(query.filters, { tags: [], categories: [], urls: [], visibility: '', health: '' });
});

test('parseSearchQuery：tag:/cat:/url:/is: 筛选抽取（含引号值），前缀不残留为关键词', () => {
  const query = parseSearchQuery('tag:图床 is:private "分类：设计" 星空');
  assert.deepEqual(query.filters.tags, ['图床']);
  assert.equal(query.filters.visibility, 'private');
  assert.equal(query.filters.health, '');
  assert.ok(query.terms.includes('星空'), '普通词应保留为关键词');
  assert.ok(!query.terms.some((term) => term.includes('tag:')), '筛选前缀不得残留');
});

test('parseSearchQuery：is:dead / is:ok / is:bad 归一到 health 筛选', () => {
  assert.equal(parseSearchQuery('is:dead').filters.health, 'dead');
  assert.equal(parseSearchQuery('is:bad').filters.health, 'dead');
  assert.equal(parseSearchQuery('is:ok').filters.health, 'ok');
  assert.equal(parseSearchQuery('is:alive').filters.health, 'ok');
  assert.equal(parseSearchQuery('is:unknown').filters.health, '');
});

test('parseSearchQuery：terms 上限 24 项；空关键词返回空 terms', () => {
  const many = parseSearchQuery('一 二 三 四 五 六 七 八 九 十 甲 乙 丙 丁 戊 己 庚 辛 壬 癸 子 丑 寅 卯 辰 巳');
  assert.ok(many.terms.length <= 24, 'terms 不得超过 24 项');
  const empty = parseSearchQuery('');
  assert.equal(empty.terms.length, 0);
  assert.equal(empty.raw, '');
});

test('matchesAdvancedFilters：visibility 与 health 谓词精确判定', () => {
  const publicSite = { visibility: 'public', catelog: '工具', last_status_code: 200, last_error: null };
  assert.equal(matchesAdvancedFilters(publicSite, { ...parseSearchQuery('').filters, visibility: 'public' }), true);
  assert.equal(matchesAdvancedFilters(publicSite, { ...parseSearchQuery('').filters, visibility: 'private' }), false);

  const deadSite = { visibility: 'public', catelog: '工具', last_status_code: 500, last_error: 'timeout' };
  assert.equal(matchesAdvancedFilters(deadSite, { ...parseSearchQuery('').filters, health: 'dead' }), true);
  assert.equal(matchesAdvancedFilters(deadSite, { ...parseSearchQuery('').filters, health: 'ok' }), false);

  const okSite = { visibility: 'public', catelog: '工具', last_status_code: 200, last_error: null };
  assert.equal(matchesAdvancedFilters(okSite, { ...parseSearchQuery('').filters, health: 'ok' }), true);
  assert.equal(matchesAdvancedFilters(okSite, { ...parseSearchQuery('').filters, health: 'dead' }), false);
});

test('matchesAdvancedFilters：标签/分类/URL 均为包含语义', () => {
  const site = {
    name: '星空图床',
    url: 'https://img.example.com/upload',
    catelog: '设计工具',
    tags: ['图片压缩', 'CDN'],
    visibility: 'public',
  };
  const base = parseSearchQuery('').filters;
  assert.equal(matchesAdvancedFilters(site, { ...base, tags: ['压缩'] }), true, '标签包含应通过');
  assert.equal(matchesAdvancedFilters(site, { ...base, tags: ['视频'] }), false, '标签不包含应拒绝');
  assert.equal(matchesAdvancedFilters(site, { ...base, categories: ['设计'] }), true, '分类包含应通过');
  assert.equal(matchesAdvancedFilters(site, { ...base, urls: ['example.com'] }), true, 'URL/域名包含应通过');
  assert.equal(matchesAdvancedFilters(site, { ...base, urls: ['other.com'] }), false, 'URL 不包含应拒绝');
});

test('scoreSite：名称完全匹配 > 名称包含 > 首字母（权重语义）', () => {
  const site = { name: '星空图床', url: 'https://x.example.com', desc: '', catelog: '', tags: [], update_time: '2020-01-01T00:00:00Z', hits: 0 };
  const exact = scoreSite(site, ['星空图床']);
  const partial = scoreSite(site, ['星空']);
  const initial = scoreSite(site, ['xktc']);
  assert.equal(exact.score, 1000, '名称完全匹配基准分 1000（无衰减加成时）');
  assert.equal(partial.score, 520, '名称包含基准分 520');
  assert.equal(initial.score, 420, '名称首字母基准分 420');
  assert.ok(exact.score > partial.score && partial.score > initial.score, '等级必须严格递减');
  assert.deepEqual(exact.matchedFields, ['name']);
  assert.deepEqual(initial.matchedFields, ['name_initials']);
  assert.ok(initial.matchReasons.includes('名称首字母匹配：xktc'), '首字母匹配理由应输出');
});

test('scoreSite：CJK 首字母路径（回归锁：此前经 mock D1 也无法直达）', () => {
  const site = { name: '星空图床', url: 'https://x.example.com', desc: '', catelog: '', tags: [], update_time: '2020-01-01T00:00:00Z', hits: 0 };
  const result = scoreSite(site, ['xktc']);
  assert.ok(result.matchedFields.includes('name_initials'), 'xktc 应命中 星空图床 的首字母');
  assert.equal(result.score, 420);
});

test('scoreSite：标签/分类/域名/描述各自入分并输出理由', () => {
  const site = {
    name: '工具站',
    url: 'https://tool.example.com',
    desc: '在线压缩',
    catelog: '效率工具',
    tags: ['图片', '批量'],
    update_time: '2020-01-01T00:00:00Z',
    hits: 0,
  };
  const result = scoreSite(site, ['图片', '效率', 'example.com', '在线压缩']);
  assert.ok(result.matchedFields.includes('tags'), '标签完全匹配应入 matchedFields');
  assert.ok(result.matchedFields.includes('category'), '分类包含应入 matchedFields');
  assert.ok(result.matchedFields.includes('url'), '域名匹配应入 matchedFields');
  assert.ok(result.matchedFields.includes('desc'), '描述包含应入 matchedFields');
  assert.ok(result.matchReasons.includes('标签完全匹配：图片'));
  assert.ok(result.matchReasons.includes('域名匹配：example.com'));
  assert.ok(result.matchReasons.includes('描述包含：在线压缩'));
});

test('scoreSite：hits 对数加成有上限；时间衰减 14 天归零', () => {
  const base = { name: '甲', url: 'https://a.example.com', desc: '', catelog: '', tags: [], update_time: '2020-01-01T00:00:00Z' };
  const zeroHits = scoreSite({ ...base, hits: 0 }, ['甲']);
  const maxHits = scoreSite({ ...base, hits: 100000 }, ['甲']);
  assert.equal(zeroHits.score, 1000, '旧数据 + 0 hits 无加成');
  // hits 先被 1000 封顶，故对数加成上限实际为 log10(1001)*24 ≈ 72.01（80 的软上限不可达）
  assert.ok(maxHits.score > 1070 && maxHits.score < 1080, 'hits 封顶 1000 时对数加成约 72');
  const fresh = scoreSite({ ...base, hits: 0, update_time: new Date(Date.now() - 3 * 86400000).toISOString() }, ['甲']);
  assert.ok(fresh.score > 1000 && fresh.score < 1040, '3 天内的新数据应获时间衰减加成（不超过 40）');
});

test('scoreSite：matchReasons 去重且截断到 8 条；多词命中叠加', () => {
  const site = {
    name: '星空图床',
    url: 'https://img.example.com',
    desc: '图片压缩与图床服务',
    catelog: '工具',
    tags: ['图床', '压缩'],
    update_time: '2020-01-01T00:00:00Z',
    hits: 0,
  };
  const result = scoreSite(site, ['星空图床', '星空图床', '图床', '压缩', '工具', 'img.example.com', '图片']);
  assert.ok(result.matchReasons.length <= 8, 'matchReasons 不得超过 8 条');
  assert.equal(new Set(result.matchReasons).size, result.matchReasons.length, 'matchReasons 不得重复');
  assert.ok(result.score > 1000 + 360, '多词命中应叠加分数');
});
