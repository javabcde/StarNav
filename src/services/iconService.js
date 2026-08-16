// 图标自动补全（Icon Auto-Fill）：抓取策略 + KV 永久失败标记 + 批量刷新（术语见 CONTEXT.md）。
// lib/favicon.js 保持纯抓取（6 源），本模块持有"何时抓 / 何时永久放弃 / 何时重置"，
// 变更记录随批量刷新写入 operation_logs（C6 服务层记录）。
import { getFavicon } from '../lib/favicon.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';

/** KV 永久失败标记键：自动路径不再重试，仅手动刷新/编辑书签清标记重置。 */
export function faviconFailedKey(id) {
  return `favicon:failed:${id}`;
}

/**
 * 幂等补全站点图标（图标自动补全）：仅在无图标且未被标记失败时抓取写回。
 * - logo 非空 → { updated:false, reason:'has-logo' }
 * - KV favicon:failed:{id} 存在 → { updated:false, reason:'already-failed' }（永久放弃，仅手动刷新/编辑重置）
 * - getFavicon 返回空（5 源全失败）→ KV 永久标记 → { updated:false, reason:'no-favicon' }
 * - 抓取/写入异常 → 不标记，下次点击再试 → { updated:false, reason:'error' }
 *
 * 注意：getFavicon 内部已吞掉各源 fetch 异常并返回 ''，此处 catch 兜底的是
 * KV/D1 写入异常。waitUntil 预算截断时整个 promise 被丢弃，不会误写标记。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_DB` 与 `NAV_AUTH`。
 * @param {object} site 站点对象（含 id/url/logo）。
 * @returns {Promise<{updated: boolean, favicon?: string, reason: string}>}
 */
export async function ensureSiteFavicon(env, site) {
  if (!site) return { updated: false, reason: 'no-site' };
  // 已有时返回现有 URL：插件缓存可能落后于 D1（主站刚补过），
  // 拿到 URL 即可本地 patch，无需再抓取
  if (site.logo) return { updated: false, favicon: site.logo, reason: 'has-logo' };

  const failedKey = faviconFailedKey(site.id);
  const failed = await env.NAV_AUTH.get(failedKey);
  if (failed) return { updated: false, reason: 'already-failed' };

  try {
    const favicon = await getFavicon(site.url);
    if (!favicon) {
      // 5 个独立源全失败 ≈ 该站没有可用图标（静态属性），永久放弃自动重试
      await env.NAV_AUTH.put(failedKey, '1');
      return { updated: false, reason: 'no-favicon' };
    }
    await env.NAV_DB.prepare(`
      UPDATE sites
      SET logo = ?, update_time = CURRENT_TIMESTAMP
      WHERE id = ?
    `).bind(favicon, site.id).run();
    return { updated: true, favicon, reason: 'filled' };
  } catch (error) {
    console.log(`[favicon] ensure failed for site ${site?.id}: ${error?.message || error}`);
    return { updated: false, reason: 'error' };
  }
}

function normalizeIdList(ids) {
  const list = Array.isArray(ids) ? ids : [];
  return [...new Set(list.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
}

/**
 * 批量刷新站点图标（手动操作 = 显式重试）：无论成败都清除自动补全的失败标记，
 * 成功后写回 logo；结果汇总写入 operation_logs（C6 服务层记录）。
 */
export async function bulkRefreshSiteFavicons(env, ids, { ip } = {}) {
  const siteIds = normalizeIdList(ids).slice(0, 30);
  if (!siteIds.length) throw new Error('ids must be a non-empty array');

  const placeholders = siteIds.map(() => '?').join(',');
  const { results: sites } = await env.NAV_DB.prepare(`
    SELECT id, name, url, logo
    FROM sites
    WHERE id IN (${placeholders})
  `).bind(...siteIds).all();

  const siteMap = new Map((sites || []).map((site) => [Number(site.id), site]));
  const results = [];

  for (const siteId of siteIds) {
    // 手动刷新 = 显式重试：无论成败都清除自动补全的失败标记（重置后点击可再触发）
    await env.NAV_AUTH.delete(faviconFailedKey(siteId)).catch(() => {});
    const site = siteMap.get(siteId);
    if (!site) {
      results.push({ id: siteId, ok: false, favicon: '', error: 'Site not found' });
      continue;
    }

    try {
      const favicon = await getFavicon(site.url);
      if (!favicon) {
        results.push({ id: siteId, name: site.name, ok: false, favicon: '', error: 'No favicon found' });
        continue;
      }

      await env.NAV_DB.prepare(`
        UPDATE sites
        SET logo = ?, update_time = CURRENT_TIMESTAMP
        WHERE id = ?
      `).bind(favicon, siteId).run();

      results.push({ id: siteId, name: site.name, ok: true, favicon, previous: site.logo || '' });
    } catch (error) {
      results.push({ id: siteId, name: site?.name || '', ok: false, favicon: '', error: error?.message || 'Refresh failed' });
    }
  }

  const result = {
    refreshed: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    total: results.length,
    results,
  };
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.SITE_BULK_FAVICON, target: 'site', summary: `批量刷新图标 ${siteIds.length} 个，成功 ${result.refreshed}`, ip });
  return result;
}
