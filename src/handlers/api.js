// API 路由表（表驱动 dispatcher）：先匹配先得，静态段条目必须排在参数段条目之前。
// 每个条目 [match, handler] 指向资源模块（api/resources/* 与 api/spaces.js）的命名处理函数；
// 处理函数签名统一 (request, env, ctx, path, method, id, url)，未命中时返回 null 落到 404。
// 鉴权（requireAdmin / requireSubmitter）与变更记录随资源模块走，不再散在路由层。
import { errorResponse, jsonResponse } from '../lib/utils.js';
import { getPublicApiDiscovery, getPublicOpenApiDocument } from './api/discovery.js';
import { handleApiError } from './api/errors.js';
import * as spaces from './api/spaces.js';
import * as sites from './api/resources/sites.js';
import * as categories from './api/resources/categories.js';
import * as tags from './api/resources/tags.js';
import * as backups from './api/resources/backups.js';
import * as settings from './api/resources/settings.js';
import * as analytics from './api/resources/analytics.js';
import * as admin from './api/resources/admin.js';
import * as ai from './api/resources/ai.js';

const exact = (path, method) => (p, m) => p === path && m === method;
const anyMethodOn = (path) => (p) => p === path || p.startsWith(`${path}/`);
const re = (pattern, method = null) => (p, m) => pattern.test(p) && (method === null || m === method);

const ROUTES = [
  // ── 公开端点（无需鉴权）──────────────────────────────
  [exact('/', 'GET'), (request, env, ctx, path, method, id, url) => jsonResponse(getPublicApiDiscovery(url.origin))],
  [exact('/discovery', 'GET'), (request, env, ctx, path, method, id, url) => jsonResponse(getPublicApiDiscovery(url.origin))],
  [exact('/openapi.json', 'GET'), (request, env, ctx, path, method, id, url) => jsonResponse(getPublicOpenApiDocument(url.origin))],
  [exact('/favicon', 'GET'), sites.faviconFetch],
  [exact('/settings/public', 'GET'), settings.publicGet],
  [exact('/spaces', 'GET'), spaces.handleGetSpaces],

  // ── 空间（管理写冻结期：POST/PUT/DELETE 过门禁后一律 409）──
  [exact('/spaces', 'POST'), spaces.handleSpacesCreate],
  [re(/^\/spaces\/[^/]+$/, 'PUT'), spaces.handleSpacesUpdate],
  [re(/^\/spaces\/[^/]+$/, 'DELETE'), spaces.handleSpacesDelete],

  // ── 站点域（sites/config/pending/submissions）────────
  [re(/^\/site\/[^/]+\/ensure-favicon$/, 'POST'), sites.ensureFavicon],
  [exact('/usage-sites', 'GET'), sites.usageSites],
  [exact('/search', 'GET'), sites.search],
  [exact('/config', 'GET'), sites.list],
  [exact('/sites', 'GET'), sites.list],
  [exact('/config', 'POST'), sites.create],
  [exact('/sites', 'POST'), sites.create],
  [exact('/sites/check-duplicate', 'GET'), sites.checkDuplicate],
  [exact('/config/submit', 'POST'), sites.submit],
  [exact('/submissions', 'POST'), sites.submit],
  [exact('/site/preview', 'GET'), sites.preview],
  [exact('/submit/suggest-category', 'POST'), sites.suggestCategory],
  [exact('/submit/suggest-tags', 'POST'), sites.suggestTags],
  [re(/^\/(?:config|sites)\/reorder$/, 'POST'), sites.reorder],
  [re(/^\/(?:config|sites)\/import\/preview$/, 'POST'), sites.importPreview],
  [re(/^\/(?:config|sites)\/import$/, 'POST'), sites.importSitesHandler],
  [re(/^\/(?:config|sites)\/bulk$/), sites.bulk],
  [re(/^\/(?:config|sites)\/export$/, 'GET'), sites.exportData],
  [re(/^\/(?:config|sites)\/\d+\/check$/, 'POST'), sites.checkHealth],
  [re(/^\/(?:config|sites)\/\d+\/unsync$/, 'POST'), sites.unsync],
  [re(/^\/(?:config|sites)\/\d+$/), sites.item],
  [exact('/sync/bookmarks', 'POST'), sites.syncBookmarksHandler],
  [re(/^\/(?:pending|submissions)$/, 'GET'), sites.pendingList],
  [re(/^\/(?:pending|submissions)\/\d+$/), sites.pendingItem],

  // ── AI ──────────────────────────────────────────────
  [exact('/ai/chat', 'POST'), ai.chat],
  [exact('/ai/admin/analyze', 'POST'), ai.adminAnalyze],

  // ── 分类 ────────────────────────────────────────────
  [exact('/categories', 'GET'), categories.list],
  [exact('/categories/tree', 'GET'), categories.tree],
  [exact('/categories/suggest', 'POST'), categories.suggest],
  [exact('/categories/reorder', 'POST'), categories.reorder],
  [exact('/categories', 'POST'), categories.create],
  [anyMethodOn('/categories'), categories.item],

  // ── 标签 ────────────────────────────────────────────
  [exact('/tags', 'GET'), tags.list],
  [exact('/tags/needs-review', 'GET'), tags.needsReview],
  [exact('/tags/suggest', 'POST'), tags.suggest],
  [exact('/tags/suggest-batch', 'POST'), tags.suggestBatch],
  [exact('/tags/apply-suggestions', 'POST'), tags.applySuggestions],
  [exact('/tags/merge-suggestions', 'POST'), tags.mergeSuggestions],
  [exact('/tags/merge', 'POST'), tags.merge],

  // ── 设置 ────────────────────────────────────────────
  [exact('/settings/system', 'GET'), settings.systemGet],
  [exact('/settings/system', 'PUT'), settings.systemPut],
  [exact('/settings/ai', 'GET'), settings.aiGet],
  [exact('/settings/ai', 'PUT'), settings.aiPut],
  [exact('/settings/ai/test', 'POST'), settings.aiTest],
  [exact('/settings/ai/models', 'POST'), settings.aiModels],
  [exact('/settings/private-bookmarks', 'GET'), settings.privateGet],
  [exact('/settings/private-bookmarks', 'PUT'), settings.privatePut],
  [exact('/settings/site-lock', 'GET'), settings.lockGet],
  [exact('/settings/site-lock', 'PUT'), settings.lockPut],
  [exact('/settings/site-lock', 'DELETE'), settings.lockDelete],

  // ── 统计 / 管理 ─────────────────────────────────────
  [exact('/analytics/search', 'GET'), analytics.search],
  [exact('/analytics/sites', 'GET'), analytics.sites],
  [exact('/analytics/submissions', 'GET'), analytics.submissions],
  [exact('/system/health', 'GET'), admin.systemHealth],
  [exact('/tokens', 'GET'), admin.listTokens],
  [exact('/tokens', 'POST'), admin.createToken],
  [anyMethodOn('/tokens'), admin.tokensItem],
  [exact('/webhooks', 'GET'), admin.webhooksList],
  [exact('/webhooks', 'POST'), admin.webhooksCreate],
  [anyMethodOn('/webhooks'), admin.webhooksItem],
  [exact('/operation-logs', 'GET'), admin.operationLogs],
  [exact('/backups/webdav-settings', 'GET'), backups.webdavSettingsGet],
  [exact('/backups/webdav-settings', 'PUT'), backups.webdavSettingsPut],
  [exact('/backups/webdav-test', 'POST'), backups.webdavTest],
  [exact('/backups', 'GET'), backups.list],
  [exact('/backups', 'POST'), backups.create],
  [anyMethodOn('/backups'), backups.item],
];

export async function handleApiRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = request.method;
  const id = path.split('/').filter(Boolean).at(-1);

  try {
    for (const [match, handler] of ROUTES) {
      if (!match(path, method)) continue;
      const response = await handler(request, env, ctx, path, method, id, url);
      if (response) return response;
    }
    return errorResponse('Not Found', 404);
  } catch (error) {
    return handleApiError(error);
  }
}
