// 投稿分析纯聚合层（submissionAnalytics.js）单测（2026-08-16 架构评审候选 6）：
// 纯函数行为 + getSubmissionAnalytics 的 9 查询编排接线（D1 mock 按 SQL 形状分发）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUBMISSION_EVENTS_SQL,
  buildCalendar,
  buildCategoryMetrics,
  buildDailySeries,
  buildDomains,
  buildHeatmap,
  buildQuality,
  buildReviewWindow,
  computeAnomalies,
  computePressure,
  computeTrend,
} from '../src/services/submissionAnalytics.js';
import { getSubmissionAnalytics } from '../src/services/submissionService.js';

test('buildDailySeries：按 safeDays 连续补全 UTC 日期，缺数据日补 0', () => {
  const now = new Date('2026-08-16T12:00:00Z');
  const daily = buildDailySeries([{ day: '2026-08-14', total: 3 }], 5, now);
  assert.equal(daily.length, 5);
  assert.equal(daily[0].day, '2026-08-12');
  assert.equal(daily[4].day, '2026-08-16');
  assert.deepEqual(daily[2], { day: '2026-08-14', total: 3 });
  assert.equal(daily[1].total, 0);
});

test('buildHeatmap：7×24 矩阵、越界行不落格、峰值与 maxHeat 正确', () => {
  const { heatmap, peakCell, maxHeat } = buildHeatmap([
    { weekday: 1, hour: 9, total: 4 },
    { weekday: 1, hour: 10, total: 2 },
  ]);
  assert.equal(heatmap.length, 7);
  assert.equal(heatmap[0].hours.length, 24);
  assert.equal(heatmap[1].hours[9].total, 4);
  assert.equal(heatmap[1].hours[10].total, 2);
  assert.equal(heatmap[0].hours[0].total, 0);
  assert.deepEqual(peakCell, { weekday: 1, hour: 9, total: 4 });
  assert.equal(maxHeat, 4);
});

test('buildHeatmap：越界行列静默不落格（SQL 侧 strftime 保证 0-6/0-23）', () => {
  const { heatmap, peakCell } = buildHeatmap([{ weekday: 7, hour: 99, total: 999 }]);
  assert.equal(heatmap[6].hours[23].total, 0);
  // 峰值候选不做越界过滤（与迁移前语义一致，真实数据不可能越界）
  assert.deepEqual(peakCell, { weekday: 7, hour: 99, total: 999 });
});

test('buildQuality：填写率/重复率/完整度/缺失计数，空结果全零', () => {
  const q = buildQuality({ total: 10, with_logo: 8, with_desc: 5, with_category: 10, unique_urls: 7 });
  assert.equal(q.logoRate, 80);
  assert.equal(q.descRate, 50);
  assert.equal(q.categoryRate, 100);
  assert.equal(q.duplicateRate, 30);
  assert.equal(q.missingLogo, 2);
  assert.equal(q.missingDesc, 5);
  assert.equal(q.duplicateUrls, 3);
  assert.equal(q.completenessScore, Math.round((80 + 50 + 100 + 70) / 4));
  assert.deepEqual(buildQuality(null), {
    total: 0, logoRate: 0, descRate: 0, categoryRate: 0, duplicateRate: 0,
    completenessScore: 0, missingLogo: 0, missingDesc: 0, duplicateUrls: 0,
  });
});

test('buildDomains：去 www/小写、非法 URL 归桶、按次数排序取前 8', () => {
  const domains = buildDomains([
    { url: 'https://www.Example.com/a' },
    { url: 'https://EXAMPLE.com/b' },
    { url: 'not a url' },
    { url: '' },
  ]);
  assert.deepEqual(domains, [
    { domain: 'example.com', total: 2 },
    { domain: '无效或非标准 URL', total: 1 },
  ]);
});

test('computeTrend：日均与环比，上期零时按有无本期取 100/0', () => {
  assert.deepEqual(computeTrend(10, 5, 30), { avgPerDay: 0.3, previousAvgPerDay: 0.2, changeRate: 100 });
  assert.deepEqual(computeTrend(10, 0, 30), { avgPerDay: 0.3, previousAvgPerDay: 0, changeRate: 100 });
  assert.deepEqual(computeTrend(0, 0, 30), { avgPerDay: 0, previousAvgPerDay: 0, changeRate: 0 });
});

test('computeAnomalies：阈值 max(3, 日均×2.5)、附倍数、降序取前 5', () => {
  const daily = [
    { day: 'a', total: 50 }, { day: 'b', total: 2 }, { day: 'c', total: 50 }, { day: 'd', total: 2 },
    { day: 'e', total: 50 }, { day: 'f', total: 2 }, { day: 'g', total: 1 },
  ];
  const anomalies = computeAnomalies(daily, 150, 30);
  assert.equal(anomalies.length, 3);
  assert.equal(anomalies[0].total, 50);
  assert.equal(anomalies[0].ratio, 10);
  assert.equal(computeAnomalies(daily, 0, 30).length, 3, '零总量时阈值仍为下限 3，≥3 的活跃日照常上报');
});

test('computePressure：加权评分封顶 100 并分档', () => {
  assert.equal(computePressure({ totalPending: 100, avgPerDay: 10, maxHeat: 10, activeDays: 30, safeDays: 30, completenessScore: 100 }).pressureScore, 100);
  assert.equal(computePressure({ totalPending: 100, avgPerDay: 10, maxHeat: 10, activeDays: 30, safeDays: 30, completenessScore: 100 }).pressureLevel, '高压');
  assert.equal(computePressure({ totalPending: 0, avgPerDay: 0, maxHeat: 0, activeDays: 0, safeDays: 30, completenessScore: 100 }).pressureLevel, '低');
});

test('buildReviewWindow：峰值后 1 小时建议，无峰值固定文案', () => {
  const w = buildReviewWindow({ weekday: 2, hour: 9, total: 5 });
  assert.equal(w.hour, 10);
  assert.ok(w.label.includes('周二 10:00 后'));
  const empty = buildReviewWindow({ weekday: null, hour: null, total: 0 });
  assert.equal(empty.label, '暂无明确高峰，建议保持每日固定时段审核。');
});

test('buildCategoryMetrics：前 8 分类与头名集中度，空数据回退', () => {
  const { categories, topCategory, categoryConcentration } = buildCategoryMetrics(
    [{ catelog: '工具', total: 4 }, { catelog: '', total: 1 }],
    8,
  );
  assert.deepEqual(categories, [{ catelog: '工具', total: 4 }, { catelog: '未分类', total: 1 }]);
  assert.equal(topCategory.catelog, '工具');
  assert.equal(categoryConcentration, 50);
  assert.equal(buildCategoryMetrics([], 0).categoryConcentration, 0);
});

test('buildCalendar：0 无提交，按 maxDaily 25/50/75% 分 1-4 级（边界含等号）', () => {
  const daily = [
    { day: 'a', total: 0 }, { day: 'b', total: 1 }, { day: 'c', total: 2 }, { day: 'd', total: 4 }, { day: 'e', total: 6 }, { day: 'f', total: 8 },
  ];
  const calendar = buildCalendar(daily, 8);
  assert.deepEqual(calendar.map((x) => x.level), [0, 1, 2, 3, 4, 4]);
});

test('SUBMISSION_EVENTS_SQL：pending 与 admin 双源并集', () => {
  assert.ok(SUBMISSION_EVENTS_SQL.includes("'pending' AS source"));
  assert.ok(SUBMISSION_EVENTS_SQL.includes("'admin' AS source"));
});

// ── 编排接线：9 次查询按 SQL 形状分发 ───────────────────────────────
function createAnalyticsMockEnv() {
  const calls = [];
  const results = {
    total: { total: 12 },
    recent: { total: 8 },
    previous: { total: 5 },
    quality: { total: 6, with_logo: 4, with_desc: 3, with_category: 5, unique_urls: 5 },
    daily: [{ day: '2026-08-10', total: 3 }],
    heatmap: [{ weekday: 1, hour: 9, total: 4 }],
    categories: [{ catelog: '工具', total: 4 }, { catelog: '', total: 1 }],
    latest: [{ id: 1, name: 'A', url: 'u', logo: '', catelog: '工具', create_time: 't', source: 'pending' }],
    domains: [{ url: 'https://www.Example.com/a' }, { url: 'not a url' }, { url: 'https://example.com/b' }],
  };
  const db = {
    prepare(sql) {
      calls.push(sql);
      const first = async () => {
        if (sql.includes("datetime('now', ?)\n      AND")) return results.previous;
        if (sql.includes('COUNT(DISTINCT')) return results.quality;
        if (sql.includes('SELECT COUNT(*) AS total FROM pending_sites')) return results.total;
        if (sql.includes(">= datetime('now', ?)")) return results.recent;
        return { total: 0 };
      };
      const all = async () => {
        if (sql.includes('date(create_time) AS day')) return { results: results.daily };
        if (sql.includes("strftime('%w'")) return { results: results.heatmap };
        if (sql.includes('GROUP BY catelog')) return { results: results.categories };
        if (sql.includes('LIMIT 8')) return { results: results.latest };
        return { results: results.domains };
      };
      return { bind: () => ({ first, all, run: async () => ({}) }), first, all };
    },
  };
  return { NAV_DB: db, calls };
}

test('getSubmissionAnalytics：9 次查询全部执行，聚合结果入响应', async () => {
  const env = createAnalyticsMockEnv();
  const data = await getSubmissionAnalytics(env, { days: 30 });

  assert.equal(env.calls.length, 9, '应执行 9 次 per-metric 查询');
  assert.equal(data.rangeDays, 30);
  assert.equal(data.summary.totalPending, 12);
  assert.equal(data.summary.recentSubmissions, 8);
  assert.equal(data.summary.previousSubmissions, 5);
  assert.equal(data.summary.changeRate, 60);
  assert.equal(data.summary.avgPerDay, 0.3);
  assert.equal(data.summary.maxHeat, 4);
  assert.deepEqual(data.summary.peakCell, { weekday: 1, hour: 9, total: 4 });
  assert.equal(data.summary.pressureLevel, '高压', '12×4 + 0.3×12 + 4×8 + 0.67 + 29×0.25 ≈ 92 分');
  assert.equal(data.quality.completenessScore, 71, 'logo 66.7 + desc 50 + cat 83.3 + 去重 83.3 四舍五入取整');
  assert.equal(data.daily.length, 30);
  assert.equal(data.heatmap.length, 7);
  assert.equal(data.heatmap[1].hours[9].total, 4);
  assert.equal(data.categories.length, 2);
  assert.equal(data.categories[0].catelog, '工具');
  assert.equal(data.latest.length, 1);
  assert.equal(data.latest[0].source, 'pending');
  assert.deepEqual(data.domains[0], { domain: 'example.com', total: 2 });
  assert.equal(data.calendar.length, 30);
  assert.ok(data.reviewWindow.label.includes('周'));
});
