// 站点资源模块（sites/config/pending/submissions 与公开投稿、搜索、同步、图标入口）。
// 路由匹配由 api.js 的表驱动 dispatcher 负责；本模块每个导出函数对应一个端点，
// 签名统一 (request, env, ctx, path, method, id, url)，未命中的方法返回 null 让 dispatcher 落到 404。
import { errorResponse, isSubmissionEnabled, jsonResponse } from '../../../lib/utils.js';

import { getFavicon } from '../../../lib/favicon.js';
import { fetchSitePreview } from '../../../lib/sitePreview.js';
import { getAccessContext } from '../../../services/accessService.js';
import { isPrivateBookmarkCategory } from '../../../services/privateBookmarkService.js';
import { clientIpFromRequest } from '../../../services/operationLogService.js';
import { getSystemSettings } from '../../../services/systemSettingsService.js';
import { syncBookmarks, unsyncSite, SYNC_EMPTY_SNAPSHOT_ERROR } from '../../../services/bookmarkSyncService.js';
import { suggestCategoryForSite, suggestTagsForSite } from '../../../services/aiService.js';
import { requireAdmin, requireSubmitter } from '../errors.js';
import { bulkRefreshSiteFavicons, ensureSiteFavicon } from '../../../services/iconService.js';
import { bulkCheckSiteHealth, checkSiteHealth } from '../../../services/siteHealthService.js';
import { sitesToBookmarkHtml, sitesToCsv } from '../sites.js';
import {
  bulkDeleteSites,
  bulkUpdateSites,
  createSite,
  deleteSite,
  getSite,
  getSites,
  listSitesByIds,
  recordSearchTerm,
  reorderSites,
  searchSites,
  updateSite,
} from '../../../services/siteService.js';
import { approvePendingSite, getPendingSites, rejectPendingSite, submitSite } from '../../../services/submissionService.js';
import { exportConfig, importSites, previewImportSites } from '../../../services/transferService.js';
import { findDuplicateSite } from '../../../services/siteCore.js';

/** GET /favicon?url= — 公开图标抓取（纯转发，策略见图标自动补全模块）。 */
export async function faviconFetch(request, env, ctx, path, method, id, url) {
  const siteUrl = url.searchParams.get('url');
  if (!siteUrl) return errorResponse('URL parameter is required', 400);
  const favicon = await getFavicon(siteUrl);
  return jsonResponse({ code: 200, favicon: favicon || '' });
}

/** POST /site/:id/ensure-favicon — 图标自动补全上报（token write 或管理员）。 */
export async function ensureFavicon(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
  if (unauthorized) return unauthorized;
  const siteId = Number(path.split('/').filter(Boolean)[1]);
  if (!Number.isInteger(siteId) || siteId <= 0) return errorResponse('Invalid site id', 400);
  const site = await getSite(env, siteId);
  if (!site) return errorResponse('Site not found', 404);
  const result = await ensureSiteFavicon(env, site);
  return jsonResponse({ code: 200, data: result });
}

/** GET /usage-sites?ids= — 按 ID 批量取站点（公开，按访问上下文过滤）。 */
export async function usageSites(request, env, ctx, path, method, id, url) {
  const access = await getAccessContext(request, env);
  const ids = (url.searchParams.get('ids') || '').split(',').map((v) => v.trim()).filter(Boolean).map(Number);
  const data = await listSitesByIds(env, ids, { access });
  return jsonResponse({ code: 200, data });
}

/** GET /search?q= — 公开搜索（含搜索词记录，waitUntil 不阻塞响应）。 */
export async function search(request, env, ctx, path, method, id, url) {
  const keyword = url.searchParams.get('q') || url.searchParams.get('keyword') || '';
  const limit = url.searchParams.get('limit') || 50;
  const access = await getAccessContext(request, env);
  const data = await searchSites(env, { keyword, limit, access });
  const recordTask = recordSearchTerm(env, keyword, data.length).catch((error) => console.warn(`[search] failed to record keyword: ${error.message}`));
  if (ctx?.waitUntil) ctx.waitUntil(recordTask);
  else await recordTask;
  return jsonResponse({ code: 200, data, total: data.length, keyword });
}

/** GET /config | /sites — 站点列表（访问上下文过滤）。 */
export async function list(request, env, ctx, path, method, id, url) {
  const page = url.searchParams.get('page') || 1;
  const pageSize = url.searchParams.get('pageSize') || 10;
  const catalog = url.searchParams.get('catalog') || '';
  const keyword = url.searchParams.get('keyword') || '';
  const tag = url.searchParams.get('tag') || '';
  const sort = url.searchParams.get('sort') || '';
  const health = url.searchParams.get('health') || '';
  const access = await getAccessContext(request, env);

  if (isPrivateBookmarkCategory(catalog) && !access.privateUnlocked) {
    return errorResponse('Private bookmarks require access password', 401);
  }

  const space = url.searchParams.get('space') || '';
  const all = url.searchParams.get('all') === '1';
  const result = await getSites(env, { page, pageSize, catalog, keyword, tag, sort, health, space, all, access });
  return jsonResponse({ code: 200, ...result });
}

/** POST /config | /sites — 创建站点（token write 或管理员；变更记录在服务层）。 */
export async function create(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const force = url.searchParams.get('force') === 'true';
  const insert = await createSite(env, body, { force, ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 201, message: 'Config created successfully', insert }, 201);
}

/** GET /sites/check-duplicate?url= — 查重（token write 或管理员）。 */
export async function checkDuplicate(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
  if (unauthorized) return unauthorized;
  const target = url.searchParams.get('url') || '';
  const excludeId = url.searchParams.get('excludeId') || null;
  if (!target) return errorResponse('url parameter is required', 400);
  const duplicate = await findDuplicateSite(env, target, { excludeId });
  return jsonResponse({ code: 200, duplicate });
}

/** POST /config/submit | /submissions — 公开投稿（投稿开关门禁）。 */
export async function submit(request, env, ctx, path, method, id, url) {
  const settings = await getSystemSettings(env);
  if (!isSubmissionEnabled(env, settings)) return errorResponse('Public submission disabled', 403);
  const insert = await submitSite(env, await request.json());
  return jsonResponse({ code: 201, message: 'Config submitted successfully, waiting for admin approve', insert }, 201);
}

/** GET /site/preview?url= — 站点信息预览（三段鉴权：管理员 / write token / 投稿开关）。 */
export async function preview(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireSubmitter(request, env);
  if (unauthorized) return unauthorized;
  const target = url.searchParams.get('url') || '';
  if (!target) return errorResponse('url parameter is required', 400);
  try {
    const data = await fetchSitePreview(target);
    const duplicate = await findDuplicateSite(env, target);
    return jsonResponse({ code: 200, data: { ...data, duplicate } });
  } catch (err) {
    return errorResponse(err?.message || '抓取网站信息失败', 400);
  }
}

/** POST /submit/suggest-category — 投稿分类建议（三段鉴权）。 */
export async function suggestCategory(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireSubmitter(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const data = await suggestCategoryForSite(env, body);
  return jsonResponse({ code: 200, data });
}

/** POST /submit/suggest-tags — 投稿标签建议（三段鉴权）。 */
export async function suggestTags(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireSubmitter(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const data = await suggestTagsForSite(env, {
    name: body?.name,
    url: body?.url,
    desc: body?.desc,
    catelog: body?.catelog,
    tags: body?.tags,
  }, { limit: Math.min(8, Number(body?.limit) || 6) });
  return jsonResponse({ code: 200, data });
}

/** POST /config | /sites /reorder — 站点排序。 */
export async function reorder(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const items = body.items || body;
  await reorderSites(env, items, { ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 200, message: 'Sites reordered successfully' });
}

/** POST /config | /sites /import/preview — 导入预览（不落库）。 */
export async function importPreview(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await previewImportSites(env, await request.json(), { mode: url.searchParams.get('mode') || 'merge' });
  return jsonResponse({ code: 200, data });
}

/** POST /config | /sites /import — 批量导入（变更记录在服务层）。 */
export async function importSitesHandler(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const importMode = url.searchParams.get('mode') || 'merge';
  const count = await importSites(env, await request.json(), { mode: importMode, ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 201, message: `Config imported successfully. ${count} items added.` }, 201);
}

/** /config | /sites /bulk — 批量操作（DELETE / PUT / POST action=check|favicon）。 */
export async function bulk(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json();
  const ip = clientIpFromRequest(request);

  if (method === 'DELETE' || (method === 'POST' && ['delete', 'bulk-delete', 'remove'].includes(body?.action))) {
    const result = await bulkDeleteSites(env, body?.ids, { ip });
    return jsonResponse({ code: 200, message: 'Configs deleted successfully', result });
  }

  if (method === 'PUT') {
    const result = await bulkUpdateSites(env, body, { ip });
    return jsonResponse({ code: 200, message: 'Configs updated successfully', result });
  }

  if (method === 'POST' && body?.action === 'check') {
    const result = await bulkCheckSiteHealth(env, body?.ids, { ip });
    return jsonResponse({ code: 200, message: 'Configs checked successfully', result });
  }

  if (method === 'POST' && ['favicon', 'refresh-favicon', 'refreshFavicons'].includes(body?.action)) {
    const result = await bulkRefreshSiteFavicons(env, body?.ids, { ip });
    return jsonResponse({ code: 200, message: 'Favicons refreshed successfully', result });
  }

  return null;
}

/** GET /config | /sites /export — 导出（csv / html / json / legacy）。 */
export async function exportData(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const exportMode = url.searchParams.get('mode');
  const exportFormat = url.searchParams.get('format');
  const data = await exportConfig(env);

  if (exportFormat === 'csv' || exportMode === 'csv') {
    return new Response(sitesToCsv(data.sites), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bookmarks.csv"',
      },
    });
  }

  if (exportFormat === 'html' || exportMode === 'html') {
    return new Response(sitesToBookmarkHtml(data.sites), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': 'attachment; filename="bookmarks.html"',
      },
    });
  }

  const payload = exportMode === 'legacy' ? data.sites : data;
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="config.json"',
    },
  });
}

/** POST /config | /sites /:id/check — 单站健康检测。 */
export async function checkHealth(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const siteId = path.split('/').filter(Boolean)[1];
  const result = await checkSiteHealth(env, siteId);
  return jsonResponse({ code: 200, message: 'Site health checked successfully', data: result });
}

/** /config | /sites /:id — 单站 GET / PUT / DELETE（token write 或管理员）。 */
export async function item(request, env, ctx, path, method, id, url) {
  if (method === 'GET') {
    const unauthorized = await requireAdmin(request, env);
    if (unauthorized) return unauthorized;
    const data = await getSite(env, id);
    if (!data) return errorResponse('Not found', 404);
    return jsonResponse({ code: 200, data });
  }

  if (method === 'PUT') {
    const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
    if (unauthorized) return unauthorized;
    const body = await request.json();
    const force = url.searchParams.get('force') === 'true';
    const update = await updateSite(env, id, body, { force, ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Config updated successfully', update });
  }

  if (method === 'DELETE') {
    const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
    if (unauthorized) return unauthorized;
    const del = await deleteSite(env, id, { ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Config deleted successfully', del });
  }

  return null;
}

/** POST /config | /sites /:id/unsync — 解除同步（token write 或管理员）。 */
export async function unsync(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
  if (unauthorized) return unauthorized;
  const siteId = path.split('/').filter(Boolean)[1];
  const result = await unsyncSite(env, siteId, { ip: clientIpFromRequest(request) });
  if (!result.exists) return errorResponse('Not found', 404);
  return jsonResponse({ code: 200, message: '已解除同步，该书签将不再参与同步对齐' });
}

/** POST /sync/bookmarks — 一键同步（token write 或管理员；汇总记录在 sync 服务层）。 */
export async function syncBookmarksHandler(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: true, scope: 'write' });
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const items = Array.isArray(body?.items) ? body.items : [];
  const source = body?.source === 'html' ? 'html' : 'extension';
  const preview = body?.preview === true || url.searchParams.get('preview') === '1';
  try {
    const result = await syncBookmarks(env, items, { source, request, dryRun: preview });
    return jsonResponse({ code: 200, data: result });
  } catch (error) {
    if (error?.message === SYNC_EMPTY_SNAPSHOT_ERROR) {
      return errorResponse('未发现可同步的书签，同步已取消（空快照保护）', 400);
    }
    throw error;
  }
}

/** GET /pending | /submissions — 待审列表（管理员）。 */
export async function pendingList(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const result = await getPendingSites(env, {
    page: url.searchParams.get('page') || 1,
    pageSize: url.searchParams.get('pageSize') || 10,
    status: url.searchParams.get('status') || 'pending',
  });
  return jsonResponse({ code: 200, ...result });
}

/** /pending | /submissions /:id — PUT 批准 / DELETE 驳回（管理员；记录在服务层）。 */
export async function pendingItem(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  if (method === 'PUT') {
    const force = url.searchParams.get('force') === 'true';
    await approvePendingSite(env, id, { force, ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Pending config approved successfully' });
  }

  if (method === 'DELETE') {
    const body = await request.json().catch(() => ({}));
    const rejectReason = body?.reason || url.searchParams.get('reason') || '';
    await rejectPendingSite(env, id, { reason: rejectReason, ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Pending config rejected successfully' });
  }

  return null;
}
