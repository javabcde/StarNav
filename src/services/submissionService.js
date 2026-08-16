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
} from './submissionAnalytics.js';
import {
  buildDuplicateError,
  findDuplicateSite,
  getPrependSortOrder,
  normalizeDuplicateUrlKey,
  normalizeSitePayload,
} from './siteCore.js';

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

  const totalResult = await env.NAV_DB.prepare('SELECT COUNT(*) AS total FROM pending_sites').first();
  const recentResult = await env.NAV_DB.prepare(`
    SELECT COUNT(*) AS total
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).first();

  const previousResult = await env.NAV_DB.prepare(`
    SELECT COUNT(*) AS total
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
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
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).first();

  const { results: dailyRows } = await env.NAV_DB.prepare(`
    SELECT date(create_time) AS day, COUNT(*) AS total
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY day
    ORDER BY day ASC
  `).bind(sinceModifier).all();

  const { results: heatmapRows } = await env.NAV_DB.prepare(`
    SELECT
      CAST(strftime('%w', create_time) AS INTEGER) AS weekday,
      CAST(strftime('%H', create_time) AS INTEGER) AS hour,
      COUNT(*) AS total
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY weekday, hour
    ORDER BY weekday ASC, hour ASC
  `).bind(sinceModifier).all();

  const { results: categoryRows } = await env.NAV_DB.prepare(`
    SELECT catelog, COUNT(*) AS total
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
    GROUP BY catelog
    ORDER BY total DESC, catelog ASC
    LIMIT 8
  `).bind(sinceModifier).all();

  const { results: latestRows } = await env.NAV_DB.prepare(`
    SELECT id, name, url, logo, catelog, create_time, source
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    ORDER BY datetime(create_time) DESC, id DESC
    LIMIT 8
  `).all();

  const { results: domainRows } = await env.NAV_DB.prepare(`
    SELECT url
    FROM (${SUBMISSION_EVENTS_SQL}) submissions
    WHERE datetime(create_time) >= datetime('now', ?)
  `).bind(sinceModifier).all();

  const daily = buildDailySeries(dailyRows, safeDays);
  const { heatmap, peakCell, maxHeat } = buildHeatmap(heatmapRows);
  const maxDaily = daily.reduce((max, item) => Math.max(max, item.total), 0);
  const recentTotal = Number(recentResult?.total) || 0;
  const previousTotal = Number(previousResult?.total) || 0;
  const totalPending = Number(totalResult?.total) || 0;
  const { avgPerDay, previousAvgPerDay, changeRate } = computeTrend(recentTotal, previousTotal, safeDays);
  const activeDays = daily.filter((item) => item.total > 0).length;
  const anomalies = computeAnomalies(daily, recentTotal, safeDays);
  const quality = buildQuality(qualityResult);
  const domains = buildDomains(domainRows);
  const { categories, categoryConcentration } = buildCategoryMetrics(categoryRows, recentTotal);
  const { pressureScore, pressureLevel } = computePressure({ totalPending, avgPerDay, maxHeat, activeDays, safeDays, completenessScore: quality.completenessScore });
  const reviewWindow = buildReviewWindow(peakCell);
  const calendar = buildCalendar(daily, maxDaily);

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
