// 投稿分析纯聚合层（submission analytics）：getSubmissionAnalytics 的纯计算部分。
// 2026-08-16 架构评审候选 6：自 submissionService 拆出——per-metric D1 查询编排
// 留在 submissionService，本模块零 D1 依赖、node:test 直接单测（此前整个分析簇零覆盖）。
// 全部函数保持纯：now 等易变输入显式入参；返回结构与原内联实现逐字段一致。
import { cleanText } from '../lib/utils.js';

// 投稿事件源（pending_sites 全部 + sites 全部，source 区分渠道），分析查询共用。
export const SUBMISSION_EVENTS_SQL = `
  SELECT id, name, url, logo, desc, catelog, create_time, 'pending' AS source
  FROM pending_sites
  UNION ALL
  SELECT id, name, url, logo, desc, catelog, create_time, 'admin' AS source
  FROM sites
`;

// 日序列补齐：按 safeDays 生成连续 UTC 日期，缺数据日补 0。
export function buildDailySeries(dailyRows, safeDays, now = new Date()) {
  const dailyMap = new Map((dailyRows || []).map((row) => [row.day, Number(row.total) || 0]));
  const daily = [];
  for (let i = safeDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push({ day: key, total: dailyMap.get(key) || 0 });
  }
  return daily;
}

// 热力矩阵 7×24 + 峰值单元 + 峰值计数（行越界静默丢弃）。
export function buildHeatmap(heatmapRows) {
  const heatmap = Array.from({ length: 7 }, (_, weekday) => ({
    weekday,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0 })),
  }));
  for (const row of heatmapRows || []) {
    const weekday = Number(row.weekday);
    const hour = Number(row.hour);
    if (weekday >= 0 && weekday < 7 && hour >= 0 && hour < 24) {
      heatmap[weekday].hours[hour].total = Number(row.total) || 0;
    }
  }
  const peakCell = (heatmapRows || []).reduce((best, row) => {
    const total = Number(row.total) || 0;
    return total > best.total ? { weekday: Number(row.weekday), hour: Number(row.hour), total } : best;
  }, { weekday: null, hour: null, total: 0 });
  const maxHeat = (heatmapRows || []).reduce((max, item) => Math.max(max, Number(item.total) || 0), 0);
  return { heatmap, peakCell, maxHeat };
}

// 质量指标：logo/描述/分类填写率、去重 URL 重复率、完整度评分、缺失计数。
export function buildQuality(qualityResult) {
  const qTotal = Number(qualityResult?.total) || 0;
  const withLogo = Number(qualityResult?.with_logo) || 0;
  const withDesc = Number(qualityResult?.with_desc) || 0;
  const withCategory = Number(qualityResult?.with_category) || 0;
  const uniqueUrls = Number(qualityResult?.unique_urls) || 0;
  const duplicateUrls = Math.max(0, qTotal - uniqueUrls);
  const pct = (value) => (qTotal ? Number(((value / qTotal) * 100).toFixed(1)) : 0);
  return {
    total: qTotal,
    logoRate: pct(withLogo),
    descRate: pct(withDesc),
    categoryRate: pct(withCategory),
    duplicateRate: pct(duplicateUrls),
    completenessScore: qTotal ? Math.round((pct(withLogo) + pct(withDesc) + pct(withCategory) + Math.max(0, 100 - pct(duplicateUrls))) / 4) : 0,
    missingLogo: Math.max(0, qTotal - withLogo),
    missingDesc: Math.max(0, qTotal - withDesc),
    duplicateUrls,
  };
}

// 域名聚合：去 www、小写、非法 URL 归桶、按次数排序取前 8。
export function buildDomains(domainRows) {
  const domainMap = new Map();
  for (const row of domainRows || []) {
    const raw = cleanText(row.url);
    if (!raw) continue;
    try {
      const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
      if (host) domainMap.set(host, (domainMap.get(host) || 0) + 1);
    } catch {
      domainMap.set('无效或非标准 URL', (domainMap.get('无效或非标准 URL') || 0) + 1);
    }
  }
  return [...domainMap.entries()]
    .map(([domain, total]) => ({ domain, total }))
    .sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain))
    .slice(0, 8);
}

// 趋势指标：日均（本期/上期）与环比变化率（上期为 0 时按有/无本期取 100/0）。
export function computeTrend(recentTotal, previousTotal, safeDays) {
  const avgPerDay = safeDays ? Number((recentTotal / safeDays).toFixed(1)) : 0;
  const previousAvgPerDay = safeDays ? Number((previousTotal / safeDays).toFixed(1)) : 0;
  const changeRate = previousTotal ? Number((((recentTotal - previousTotal) / previousTotal) * 100).toFixed(1)) : (recentTotal ? 100 : 0);
  return { avgPerDay, previousAvgPerDay, changeRate };
}

// 异常日：总量 >= max(3, 日均×2.5) 的活跃日，附倍数、按总量降序取前 5。
export function computeAnomalies(daily, recentTotal, safeDays) {
  const dailyAverage = recentTotal / Math.max(1, safeDays);
  return daily
    .filter((item) => item.total > 0 && item.total >= Math.max(3, dailyAverage * 2.5))
    .map((item) => ({ ...item, ratio: Number((item.total / Math.max(1, dailyAverage)).toFixed(1)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
}

// 审核压力：积压/日均/峰值/活跃天/完整度加权，封顶 100 并分档。
export function computePressure({ totalPending, avgPerDay, maxHeat, activeDays, safeDays, completenessScore }) {
  const pressureScore = Math.min(100, Math.round(
    totalPending * 4 +
    avgPerDay * 12 +
    maxHeat * 8 +
    (activeDays / Math.max(1, safeDays)) * 20 +
    Math.max(0, 100 - completenessScore) * 0.25
  ));
  const pressureLevel = pressureScore >= 80 ? '高压' : pressureScore >= 55 ? '偏高' : pressureScore >= 30 ? '正常' : '低';
  return { pressureScore, pressureLevel };
}

// 审核窗口建议：峰值后 1 小时；无峰值时给固定时段文案。
export function buildReviewWindow(peakCell) {
  if (!peakCell.total) {
    return {
      weekday: null,
      hour: null,
      label: '暂无明确高峰，建议保持每日固定时段审核。',
      reason: '当前周期提交量较少，暂未形成稳定提交窗口。',
    };
  }
  return {
    weekday: peakCell.weekday,
    hour: (peakCell.hour + 1) % 24,
    label: `建议在提交高峰后 1 小时集中审核：周${['日', '一', '二', '三', '四', '五', '六'][peakCell.weekday]} ${String((peakCell.hour + 1) % 24).padStart(2, '0')}:00 后`,
    reason: `当前峰值为 ${String(peakCell.hour).padStart(2, '0')}:00，峰值后处理通常能减少积压。`,
  };
}

// 分类占比：前 8 分类 + 头名集中度（相对本期提交总量）。
export function buildCategoryMetrics(categoryRows, recentTotal) {
  const categories = (categoryRows || []).map((row) => ({ catelog: row.catelog || '未分类', total: Number(row.total) || 0 }));
  const topCategory = categories[0];
  const categoryConcentration = topCategory && recentTotal ? Number(((topCategory.total / recentTotal) * 100).toFixed(1)) : 0;
  return { categories, topCategory, categoryConcentration };
}

// 日历等级：0 无提交，否则按 maxDaily 的 25%/50%/75% 分 1-4 级。
export function buildCalendar(daily, maxDaily) {
  return daily.map((item) => ({
    ...item,
    level: item.total === 0 ? 0 : item.total >= maxDaily * 0.75 ? 4 : item.total >= maxDaily * 0.5 ? 3 : item.total >= maxDaily * 0.25 ? 2 : 1,
  }));
}
