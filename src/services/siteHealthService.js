// 站点健康检测执行簇（sites 表健康检查）：check / bulk / scheduled 三入口。
// 2026-08-16 架构评审候选 3：从 siteService 迁出——本簇不依赖 siteService 私有查询基建
// （SITE_SELECT_COLUMNS / applyVisibilityWhere），只消费已导出的 getSite 与 lib 层；
// 谓词渲染在 healthQuery.js（SQL + JS 单一源），聚合在 systemHealthService.js，
// 调度入口在 index.js。本模块只做「抓取检查 + 写回检测结果」。
// 注意：checkSiteHealth 依赖 siteService.getSite，故 siteService 不设 re-export 垫片
// （避免双向深循环），消费方一律直连本模块。
import { cleanText, normalizeIdList } from '../lib/utils.js';
import { safeFetch } from '../lib/ssrf.js';
import { getSite } from './siteService.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';

function normalizeCheckUrl(value) {
  const text = cleanText(value);
  if (!text) return '';
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

export async function checkSiteHealth(env, id) {
  const siteId = Number(id);
  if (!Number.isInteger(siteId) || siteId <= 0) throw new Error('Invalid site id');

  const site = await getSite(env, siteId);
  if (!site) throw new Error('Site not found');

  const targetUrl = normalizeCheckUrl(site.url);
  let statusCode = null;
  let error = '';

  if (!targetUrl) {
    error = 'URL is empty';
  } else {
    try {
      new URL(targetUrl);
      let response;
      try {
        response = await safeFetch(targetUrl, {
          method: 'HEAD',
          signal: AbortSignal.timeout(8000),
          headers: { 'User-Agent': 'StarNav-LinkChecker/1.0' },
        });
      } catch (headError) {
        response = await safeFetch(targetUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
          headers: { 'User-Agent': 'StarNav-LinkChecker/1.0' },
        });
      }
      statusCode = response.status;
      error = response.ok ? '' : `HTTP ${response.status}`;
    } catch (checkError) {
      error = checkError?.message || 'Check failed';
    }
  }

  await env.NAV_DB.prepare(`
    UPDATE sites
    SET last_checked_at = CURRENT_TIMESTAMP,
        last_status_code = ?,
        last_error = ?,
        update_time = CURRENT_TIMESTAMP
    WHERE id = ?
  `).bind(statusCode, error || null, siteId).run();

  return {
    id: siteId,
    ok: Boolean(statusCode && statusCode >= 200 && statusCode < 400 && !error),
    status_code: statusCode,
    error,
    checked_at: new Date().toISOString(),
  };
}

export async function bulkCheckSiteHealth(env, ids, { ip } = {}) {
  const siteIds = normalizeIdList(ids).slice(0, 30);
  if (!siteIds.length) throw new Error('ids must be a non-empty array');

  const results = [];
  for (const siteId of siteIds) {
    results.push(await checkSiteHealth(env, siteId));
  }

  const result = {
    checked: results.length,
    ok: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  };
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_BULK_CHECK, target: 'site', summary: `批量检测 ${results.length} 个书签，正常 ${result.ok}，异常 ${result.failed}`, ip });
  return result;
}

export async function runScheduledHealthCheck(env, { limit = 30 } = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const { results: rows } = await env.NAV_DB.prepare(`
    SELECT id
    FROM sites
    ORDER BY
      CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END ASC,
      datetime(COALESCE(last_checked_at, '1970-01-01 00:00:00')) ASC,
      id ASC
    LIMIT ?
  `).bind(safeLimit).all();
  const ids = (rows || []).map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) {
    return { checked: 0, ok: 0, failed: 0, results: [] };
  }
  return bulkCheckSiteHealth(env, ids);
}
