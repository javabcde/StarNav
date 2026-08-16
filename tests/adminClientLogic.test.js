// 后台客户端纯逻辑（clientLogic.js 后台簇）单测（2026-08-16 架构评审候选 2 第二刀）：
// heatLevel/formatPeak/getAnalyticsScores/normalizePickerColor/formatTokenScopes/
// syncStatPill/syncListHtml/syncFailedHtml/renderSyncStats/formatBytes/webdavStatusText/
// normalizeAiAdminItems —— 均经 toString() 生成期内联进 adminJs 模板，测试即行为契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEEKDAY_NAMES,
  formatBytes,
  formatPeak,
  formatTokenScopes,
  getAnalyticsScores,
  heatLevel,
  normalizeAiAdminItems,
  normalizePickerColor,
  renderSyncStats,
  syncFailedHtml,
  syncListHtml,
  syncStatPill,
  webdavStatusText,
} from '../src/pages/clientLogic.js';

test('内联契约回归锁：后台簇全部导出函数源码不含反引号与 ${', () => {
  for (const fn of [formatBytes, formatPeak, formatTokenScopes, getAnalyticsScores, heatLevel, normalizeAiAdminItems, normalizePickerColor, renderSyncStats, syncFailedHtml, syncListHtml, syncStatPill, webdavStatusText]) {
    const source = fn.toString();
    assert.ok(!source.includes('`'), `${fn.name} 源码含反引号，破坏模板内联前提`);
    assert.ok(!source.includes('${'), `${fn.name} 源码含未插值 \${，破坏模板插值面收敛`);
  }
  assert.deepEqual(WEEKDAY_NAMES, ['周日', '周一', '周二', '周三', '周四', '周五', '周六']);
});

test('heatLevel：0/1/2/3/4 五档阈值', () => {
  assert.equal(heatLevel(0, 10), 0);
  assert.equal(heatLevel(2, 10), 1);
  assert.equal(heatLevel(3, 10), 2);
  assert.equal(heatLevel(6, 10), 3);
  assert.equal(heatLevel(8, 10), 4);
  assert.equal(heatLevel(10, 0), 0);
});

test('formatPeak：峰值时段文案与空值回退', () => {
  assert.equal(formatPeak({ weekday: 2, hour: 9, total: 5 }), '周二 09:00');
  assert.equal(formatPeak(null), '暂无');
  assert.equal(formatPeak({ weekday: 0, hour: 0, total: 0 }), '暂无');
});

test('getAnalyticsScores：五维评分形状与边界', () => {
  const scores = getAnalyticsScores({
    summary: { recentSubmissions: 10, totalPending: 40, maxHeat: 30 },
    daily: [{ total: 1 }, { total: 0 }],
    categories: [{ total: 6 }],
    rangeDays: 30,
  });
  assert.equal(scores.length, 5);
  for (const s of scores) {
    assert.ok(s.value >= 0 && s.value <= 100, `${s.name} 评分应在 0-100：${s.value}`);
  }
  assert.equal(scores[0].name, '活跃度');
  assert.equal(scores[3].value, 100, '待处理压力 40/20 应封顶 100');
});

test('normalizePickerColor：仅 #rrggbb 有效，其余回退默认', () => {
  assert.equal(normalizePickerColor('#1a2B3c'), '#1a2B3c');
  assert.equal(normalizePickerColor('red'), '#b86b4b');
  assert.equal(normalizePickerColor('#12345'), '#b86b4b');
  assert.equal(normalizePickerColor(''), '#b86b4b');
});

test('formatTokenScopes：数组/字符串/空均归一为徽章', () => {
  assert.equal(formatTokenScopes(['read', 'write']), '<span class="tag-pill">read</span> <span class="tag-pill">write</span>');
  assert.equal(formatTokenScopes('read, write'), '<span class="tag-pill">read</span> <span class="tag-pill">write</span>');
  assert.equal(formatTokenScopes(''), '<span class="tag-pill">read</span>');
  assert.equal(formatTokenScopes('a<b'), '<span class="tag-pill">a&lt;b</span>');
});

test('同步簇：药丸/列表/失败清单/统计条', () => {
  assert.ok(syncStatPill('新增', 3).includes('>新增</span><strong style="color:#24211d">3</strong>'));
  assert.ok(syncStatPill('删除', 1, true).includes('#963d3d'));
  assert.equal(syncListHtml([{ name: 'A', url: 'https://a.test' }]), '<li>A（https://a.test）</li>');
  assert.ok(syncListHtml(Array.from({ length: 60 }, (_, i) => ({ name: 'x' + i, url: 'u' }))).includes('等共 60 条'));
  assert.equal(syncFailedHtml([]), '');
  assert.ok(syncFailedHtml([{ url: 'u', reason: 'r' }]).includes('失败 1 条'));
  const html = renderSyncStats('', { added: 1, updated: 2, deleted: 3, skipped: 4, failed: 5 });
  assert.ok(html.includes('新增') && html.includes('失败') && html.includes('删除'));
});

test('formatBytes：B/KB/MB 分档', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(1048576 * 3), '3.00 MB');
});

test('webdavStatusText：上传/跳过/失败/无记录四态', () => {
  assert.equal(webdavStatusText({}), '');
  assert.equal(webdavStatusText({ webdav: { uploaded: true, fileName: 'a.json' } }), '，WebDAV 已上传：a.json');
  assert.equal(webdavStatusText({ webdav: { skipped: true } }), '，WebDAV 未启用');
  assert.equal(webdavStatusText({ webdav: { error: 'HTTP 401' } }), '，WebDAV 上传失败：HTTP 401');
});

test('normalizeAiAdminItems：四类分析与未知类型回退', () => {
  const noTags = normalizeAiAdminItems('no-tags', { sites: [{ id: 1, name: 'A', catelog: '工具', url: 'https://a' }], suggestions: [{ siteId: 1, tags: ['x'] }], total: 1 });
  assert.equal(noTags.items[0].suggestion, '推荐标签：x');

  const dups = normalizeAiAdminItems('duplicates', { groups: [{ domainKey: 'd.com', count: 2, sites: [{ id: 1, name: 'A', hits: 5 }] }], suggestions: [{ domainKey: 'd.com', isDuplicate: true, keepId: 1 }], groupCount: 1 });
  assert.ok(dups.items[0].suggestion.includes('建议保留 #1'));

  const gaps = normalizeAiAdminItems('search-gaps', { gaps: [{ keyword: 'k', totalSearches: 3, zeroResultCount: 2 }], suggestions: [{ keyword: 'k', suggestions: [{ name: 'S' }] }] });
  assert.ok(gaps.items[0].suggestion.includes('建议收录：S'));

  const cats = normalizeAiAdminItems('category-errors', { orphaned: [{ id: 1, name: 'A', issue: '无分类' }], suggestions: [{ siteId: 1, suggestedCategory: '工具' }], totalOrphaned: 1 });
  assert.equal(cats.items[0].suggestion, '建议改为：工具');

  assert.deepEqual(normalizeAiAdminItems('unknown', {}), { items: [], total: 0 });
});
