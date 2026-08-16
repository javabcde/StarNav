// 投稿审核域（pending_sites 表）：公开投稿、审核队列列表、投稿分析、批准/驳回。
// 自 siteService 拆出（2026-08-16 架构评审候选 5，纯搬迁）；siteService 保留同名 re-export 垫片，
// 存量测试与调用方 import 面不变（同 ADR-0003 模式）。
// 本域只拥有 pending_sites 表；sites 表的共享 helper（载荷规范化 / 去重查询 / 排序前置 / 分类 / 标签）
// 仍由 siteService 单一持有，此处 import 复用，不复制。operation_logs 记录随函数内联迁入（ADR-0004 约定写服务内部记录）。
import { cleanText } from '../lib/utils.js';
import { upsertCategoryByName } from './categoryService.js';
import { normalizeVisibility } from './accessService.js';
import { normalizeTags, setSiteTags } from './tagService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';
import {
  buildDuplicateError,
  findDuplicateSite,
  getPrependSortOrder,
  normalizeDuplicateUrlKey,
  normalizeSitePayload,
} from './siteService.js';

function parseStoredTags(value) {
  if (Array.isArray(value)) return normalizeTags(value);
  const text = cleanText(value);
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return normalizeTags(parsed);
  } catch {
    // 兼容非 JSON 的逗号/空格分隔标签
  }

  return normalizeTags(text);
}

export async function submitSite(env, config) {
  const site = normalizeSitePayload(config);
  const reason = cleanText(config?.reason).slice(0, 500) || null;
  const duplicate = await findDuplicateSite(env, site.url);
  if (duplicate) throw buildDuplicateError(duplicate, 'submit');

  return env.NAV_DB.prepare(`
    INSERT INTO pending_sites (name, url, logo, desc, catelog, tags, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(site.name, site.url, site.logo, site.desc, site.catelog, JSON.stringify(site.tags), reason).run();
}

export async function getPendingSites(env, { page = 1, pageSize = 10, status = '' } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safePageSize = Math.max(1, Math.min(100, Number(pageSize) || 10));
  const offset = (safePage - 1) * safePageSize;
  const safeStatus = ['pending', 'approved', 'rejected'].includes(String(status || '').toLowerCase())
    ? String(status).toLowerCase()
    : 'pending';

  const emptyResult = {
    data: [],
    total: 0,
    page: safePage,
    pageSize: safePageSize,
    status: safeStatus,
    stats: { pending: 0, approved: 0, rejected: 0 },
  };

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT * FROM pending_sites
      WHERE COALESCE(status, 'pending') = ?
      ORDER BY datetime(COALESCE(reviewed_at, create_time)) DESC, id DESC
      LIMIT ? OFFSET ?
    `).bind(safeStatus, safePageSize, offset).all();

    const countResult = await env.NAV_DB.prepare(`
      SELECT COUNT(*) AS total FROM pending_sites WHERE COALESCE(status, 'pending') = ?
    `).bind(safeStatus).first();

    const stats = await env.NAV_DB.prepare(`
      SELECT
        SUM(CASE WHEN COALESCE(status, 'pending') = 'pending' THEN 1 ELSE 0 END) AS pending_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved_count,
        SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
      FROM pending_sites
    `).first();

    return {
      data: (results || []).map((site) => ({ ...site, tags: parseStoredTags(site.tags) })),
      total: countResult?.total || 0,
      page: safePage,
      pageSize: safePageSize,
      status: safeStatus,
      stats: {
        pending: Number(stats?.pending_count) || 0,
        approved: Number(stats?.approved_count) || 0,
        rejected: Number(stats?.rejected_count) || 0,
      },
    };
  } catch (error) {
    console.warn(`[pending] primary query fallback: ${error?.message || error}`);
  }

  if (safeStatus !== 'pending') return emptyResult;

  try {
    const { results } = await env.NAV_DB.prepare(`
      SELECT id, name, url, logo, desc, catelog, create_time
      FROM pending_sites
      ORDER BY datetime(create_time) DESC, id DESC
      LIMIT ? OFFSET ?
    `).bind(safePageSize, offset).all();

    const countResult = await env.NAV_DB.prepare('SELECT COUNT(*) AS total FROM pending_sites').first();
    const total = Number(countResult?.total) || 0;

    return {
      data: (results || []).map((site) => ({ ...site, status: 'pending', tags: [] })),
      total,
      page: safePage,
      pageSize: safePageSize,
      status: safeStatus,
      stats: { pending: total, approved: 0, rejected: 0 },
    };
  } catch (error) {
    console.warn(`[pending] legacy query fallback: ${error?.message || error}`);
    return emptyResult;
  }
}

export async function getSubmissionAnalytics(env, { days = 30 } = {}) {
  const safeDays = Math.max(7, Math.min(180, Number(days) || 30));
  const sinceModifier = `-${safeDays - 1} days`;
  const previousStartModifier = `-${safeDays * 2 - 1} days`;
  const previousEndModifier = `-${safeDays} days`;
  const submissionEventsSql = `
    SELECT id, name, url, logo, desc, catelog, create_time, 'pending' AS source
    FROM pending_sites
    UNION ALL
    SELECT id, name, url, logo, desc, catelog, create_time, 'admin' AS source
    FROM sites
  `;

  const totalResult = await env.NAV_DB.prepare('SELECT COUNT(*) AS total FROM pending_sites').first();
  const recentResult = await env.NAV_DB.prepare(`
    SELECT COUNT(*) AS total
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).first();

  const previousResult = await env.NAV_DB.prepare(`
    SELECT COUNT(*) AS total
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
      AND datetime(create_time) < datetime('now', ?)
  `).bind(previousStartModifier, previousEndModifier).first();

  const qualityResult = await env.NAV_DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(TRIM(logo), '') <> '' THEN 1 ELSE 0 END) AS with_logo,
      SUM(CASE WHEN COALESCE(TRIM(desc), '') <> '' THEN 1 ELSE 0 END) AS with_desc,
      SUM(CASE WHEN COALESCE(TRIM(catelog), '') <> '' THEN 1 ELSE 0 END) AS with_category,
      COUNT(DISTINCT LOWER(TRIM(url))) AS unique_urls
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).first();

  const { results: dailyRows } = await env.NAV_DB.prepare(`
    SELECT date(create_time) AS day, COUNT(*) AS total
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY day
    ORDER BY day ASC
  `).bind(sinceModifier).all();

  const { results: heatmapRows } = await env.NAV_DB.prepare(`
    SELECT
      CAST(strftime('%w', create_time) AS INTEGER) AS weekday,
      CAST(strftime('%H', create_time) AS INTEGER) AS hour,
      COUNT(*) AS total
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY weekday, hour
    ORDER BY weekday ASC, hour ASC
  `).bind(sinceModifier).all();

  const { results: categoryRows } = await env.NAV_DB.prepare(`
    SELECT catelog, COUNT(*) AS total
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY catelog
    ORDER BY total DESC, catelog ASC
    LIMIT 8
  `).bind(sinceModifier).all();

  const { results: latestRows } = await env.NAV_DB.prepare(`
    SELECT id, name, url, logo, catelog, create_time, source
    FROM (${submissionEventsSql}) submissions
    ORDER BY datetime(create_time) DESC, id DESC
    LIMIT 8
  `).all();

  const { results: domainRows } = await env.NAV_DB.prepare(`
    SELECT url
    FROM (${submissionEventsSql}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).all();

  const dailyMap = new Map((dailyRows || []).map((row) => [row.day, Number(row.total) || 0]));
  const daily = [];
  const now = new Date();
  for (let i = safeDays - 1; i >= 0; i -= 1) {
    const d = new Date(now);
    d.setUTCDate(now.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    daily.push({ day: key, total: dailyMap.get(key) || 0 });
  }

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

  const maxDaily = daily.reduce((max, item) => Math.max(max, item.total), 0);
  const maxHeat = (heatmapRows || []).reduce((max, item) => Math.max(max, Number(item.total) || 0), 0);
  const recentTotal = Number(recentResult?.total) || 0;
  const previousTotal = Number(previousResult?.total) || 0;
  const totalPending = Number(totalResult?.total) || 0;
  const avgPerDay = safeDays ? Number((recentTotal / safeDays).toFixed(1)) : 0;
  const previousAvgPerDay = safeDays ? Number((previousTotal / safeDays).toFixed(1)) : 0;
  const changeRate = previousTotal ? Number((((recentTotal - previousTotal) / previousTotal) * 100).toFixed(1)) : (recentTotal ? 100 : 0);
  const activeDays = daily.filter((item) => item.total > 0).length;
  const dailyAverage = recentTotal / Math.max(1, safeDays);
  const anomalies = daily
    .filter((item) => item.total > 0 && item.total >= Math.max(3, dailyAverage * 2.5))
    .map((item) => ({ ...item, ratio: Number((item.total / Math.max(1, dailyAverage)).toFixed(1)) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);

  const qTotal = Number(qualityResult?.total) || 0;
  const withLogo = Number(qualityResult?.with_logo) || 0;
  const withDesc = Number(qualityResult?.with_desc) || 0;
  const withCategory = Number(qualityResult?.with_category) || 0;
  const uniqueUrls = Number(qualityResult?.unique_urls) || 0;
  const duplicateUrls = Math.max(0, qTotal - uniqueUrls);
  const pct = (value) => qTotal ? Number(((value / qTotal) * 100).toFixed(1)) : 0;
  const quality = {
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
  const domains = [...domainMap.entries()]
    .map(([domain, total]) => ({ domain, total }))
    .sort((a, b) => b.total - a.total || a.domain.localeCompare(b.domain))
    .slice(0, 8);

  const categories = (categoryRows || []).map((row) => ({ catelog: row.catelog || '未分类', total: Number(row.total) || 0 }));
  const topCategory = categories[0];
  const categoryConcentration = topCategory && recentTotal ? Number(((topCategory.total / recentTotal) * 100).toFixed(1)) : 0;
  const pressureScore = Math.min(100, Math.round(
    totalPending * 4 +
    avgPerDay * 12 +
    maxHeat * 8 +
    (activeDays / Math.max(1, safeDays)) * 20 +
    Math.max(0, 100 - quality.completenessScore) * 0.25
  ));
  const pressureLevel = pressureScore >= 80 ? '高压' : pressureScore >= 55 ? '偏高' : pressureScore >= 30 ? '正常' : '低';

  const reviewWindow = peakCell.total
    ? {
        weekday: peakCell.weekday,
        hour: (peakCell.hour + 1) % 24,
        label: `建议在提交高峰后 1 小时集中审核：周${['日', '一', '二', '三', '四', '五', '六'][peakCell.weekday]} ${String((peakCell.hour + 1) % 24).padStart(2, '0')}:00 后`,
        reason: `当前峰值为 ${String(peakCell.hour).padStart(2, '0')}:00，峰值后处理通常能减少积压。`,
      }
    : {
        weekday: null,
        hour: null,
        label: '暂无明确高峰，建议保持每日固定时段审核。',
        reason: '当前周期提交量较少，暂未形成稳定提交窗口。',
      };

  const calendar = daily.map((item) => ({
    ...item,
    level: item.total === 0 ? 0 : item.total >= maxDaily * 0.75 ? 4 : item.total >= maxDaily * 0.5 ? 3 : item.total >= maxDaily * 0.25 ? 2 : 1,
  }));

  return {
    rangeDays: safeDays,
    summary: {
      totalPending,
      recentSubmissions: recentTotal,
      previousSubmissions: previousTotal,
      changeRate,
      avgPerDay,
      previousAvgPerDay,
      activeDays,
      peakCell,
      maxDaily,
      maxHeat,
      pressureScore,
      pressureLevel,
      categoryConcentration,
    },
    quality,
    reviewWindow,
    anomalies,
    daily,
    calendar,
    heatmap,
    categories,
    domains,
    latest: (latestRows || []).map((row) => ({ ...row })),
  };
}

export async function approvePendingSite(env, id, { force = false, ip } = {}) {
  const config = await env.NAV_DB.prepare('SELECT * FROM pending_sites WHERE id = ?').bind(id).first();
  if (!config) throw new Error('Pending config not found');
  if (config.status === 'approved') throw new Error('This submission has already been approved');

  if (!force) {
    const duplicate = await findDuplicateSite(env, config.url);
    if (duplicate) throw buildDuplicateError(duplicate, 'approve');
  }

  const spaceId = null; // 批准后进入默认空空间，避免空间表异常影响审核流程
  const sortOrder = await getPrependSortOrder(env, spaceId);
  const category = await upsertCategoryByName(env, config.catelog, sortOrder);

  const visibility = normalizeVisibility(config.visibility, config.catelog);
  const result = await env.NAV_DB.prepare(`
    INSERT INTO sites (name, url, logo, desc, catelog, category_id, space_id, visibility, sort_order, url_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(config.name, config.url, config.logo, config.desc, config.catelog, category?.id || null, spaceId, visibility, sortOrder, normalizeDuplicateUrlKey(config.url)).run();

  const siteId = result?.meta?.last_row_id;
  if (siteId) await setSiteTags(env, siteId, parseStoredTags(config.tags));

  await env.NAV_DB.prepare(`
    UPDATE pending_sites SET status = 'approved', reviewed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(id).run();
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.PENDING_APPROVE, target: 'pending_site', targetId: id, ip });
}

export async function rejectPendingSite(env, id, { reason = '', ip } = {}) {
  const config = await env.NAV_DB.prepare('SELECT * FROM pending_sites WHERE id = ?').bind(id).first();
  if (!config) throw new Error('Pending config not found');

  const rejectReason = cleanText(reason).slice(0, 200) || null;
  await env.NAV_DB.prepare(`
    UPDATE pending_sites SET status = 'rejected', reject_reason = ?, reviewed_at = CURRENT_TIMESTAMP WHERE id = ?
  `).bind(rejectReason, id).run();
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.PENDING_REJECT, target: 'pending_site', targetId: id, summary: rejectReason || undefined, ip });
}
