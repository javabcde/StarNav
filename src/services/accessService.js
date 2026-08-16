// 访问上下文（Access Context）：单个请求访问等级的组合判定（术语见 CONTEXT.md）。
//
// 只做读侧判定——写侧状态转移（登录建会话、解锁种 cookie、token 吊销、失败限速）
// 留在各自 service。鉴权 cookie 名单与整站锁白名单策略收归本模块，消费方
// （edgeCache、handlers、services）不再各自重推规则。决策见 docs/adr/0003。
import {
  SESSION_COOKIE_NAME,
  hasBearerToken,
  isAdminAuthenticated,
  parseCookies,
  validateApiToken,
} from '../lib/auth.js';
import { cleanText } from '../lib/utils.js';
import {
  PRIVATE_ACCESS_COOKIE_NAME,
  PRIVATE_BOOKMARK_CATEGORY,
  hasPrivateBookmarkAccess,
} from './privateBookmarkService.js';
import {
  SITE_LOCK_COOKIE_NAME,
  hasSiteLockAccess,
  isSiteLockEnabled,
} from './siteLockService.js';

// 请求级访问上下文缓存：同一请求内多处调用只推导一次。
// WeakMap 键为 Request 对象，请求结束即随对象回收，无跨请求泄漏。
// 因此 KV 读次数不劣于现状（各凭据每请求最多一次）。
const accessContextCache = new WeakMap();

/**
 * 推导当前请求的访问上下文（懒计算 + 按请求去重）。
 *
 * @param {Request} request 当前请求。
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @returns {Promise<object>} 访问上下文对象。
 */
export async function getAccessContext(request, env) {
  const cached = accessContextCache.get(request);
  if (cached) return cached;
  const context = deriveAccessContext(request, env);
  accessContextCache.set(request, context);
  return context;
}

async function deriveAccessContext(request, env) {
  const adminAuthed = await isAdminAuthenticated(request, env);

  // token 校验独立于 admin 执行：requireAdmin 需要复现「弱 token + admin cookie → 403」的
  // 既有优先级（token 存在但 scope 不足时先于 admin 会话判定短路）。
  // 无 Bearer 头时不发起 KV 校验（匿名页面渲染零额外开销）。
  let tokenAuthenticated = false;
  let tokenScopes = [];
  if (hasBearerToken(request)) {
    const tokenAuth = await validateApiToken(request, env, '');
    tokenAuthenticated = Boolean(tokenAuth?.authenticated);
    tokenScopes = tokenAuth?.token?.scopes || [];
  }

  // 私人书签解锁分两层：
  // - browserPrivateUnlocked：admin 会话或私人书签 cookie（浏览器页面语义，go/home 用）；
  // - privateUnlocked：再加有效 Bearer Token（API 读接口语义，见 ADR-0002——token 即密码级凭据）。
  // 页面路由不授予 token 私人书签权限（迁移前 go.js / home.js 亦如此，勿扩展）。
  const browserPrivateUnlocked = adminAuthed || (await hasPrivateBookmarkAccess(request, env));
  const privateUnlocked = browserPrivateUnlocked || tokenAuthenticated;

  // 整站锁（懒求值）：无人消费时零 KV 开销——锁门 handler 自行判定，本字段仅为
  // 需要「整站锁状态」的消费者提供。读失败视为未锁（handler 自会兜底）。
  let siteLockedPromise = null;

  const context = {
    adminAuthed,
    tokenAuthenticated,
    tokenScopes,
    browserPrivateUnlocked,
    privateUnlocked,
    get siteLocked() {
      if (!siteLockedPromise) {
        siteLockedPromise = (async () => {
          try {
            return !adminAuthed && !(await hasSiteLockAccess(request, env)) && (await isSiteLockEnabled(env));
          } catch {
            return false;
          }
        })();
      }
      return siteLockedPromise;
    },
    cacheAllowed: isCacheableHomeRequest(request),
    // 可见性判定：页面语义（browserPrivateUnlocked）；API 读接口由调用方直接使用
    // privateUnlocked 字段（SQL 级过滤），两者各自独立，勿混用。
    canAccess: (site) => canAccessSite(site, { adminAuthed, privateUnlocked: browserPrivateUnlocked }),
    canList: (site) => canListSite(site, { adminAuthed, privateUnlocked: browserPrivateUnlocked }),
  };
  return context;
}

/**
 * 首页请求是否可走共享边缘缓存。
 *
 * 安全前提：只缓存"完全匿名"的响应——任一鉴权相关 cookie（管理员会话 / 私人书签访问 /
 * 整站锁解锁）存在即为个性化请求。名单收归本模块后，新增鉴权 cookie 只需改这里，
 * edgeCache 零感知。
 *
 * @param {Request} request 当前请求。
 * @returns {boolean}
 */
export function isCacheableHomeRequest(request) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  return !(cookies[SESSION_COOKIE_NAME] || cookies[PRIVATE_ACCESS_COOKIE_NAME] || cookies[SITE_LOCK_COOKIE_NAME]);
}

/**
 * 整站锁白名单：这些路由在锁启用时仍可匿名访问。
 * PWA 静态资源无需在此列出——handlePwaRequest 在 routeRequest 中先于本策略执行。
 *
 * @param {string} path URL pathname。
 * @param {string} method HTTP 方法。
 * @returns {boolean}
 */
export function isSiteLockAllowlisted(path, method) {
  if (path === '/admin' && (method === 'GET' || method === 'POST')) return true;
  if (path.startsWith('/static/')) return true;
  if (path === '/api/settings/public' && method === 'GET') return true;
  return false;
}

// ── 站点可见性规则（自 siteService 迁入，依赖方向 siteService → accessService）──────

export const SITE_VISIBILITIES = ['public', 'private', 'unlisted', 'admin_only'];

/**
 * 将外部输入规范化为站点可见性枚举。
 *
 * 私密书签分类会自动回退为 `private`，其他非法值默认回退为 `public`。
 *
 * @param {unknown} value 原始可见性输入。
 * @param {unknown} [catelog=''] 分类名称，用于兼容私密书签旧数据。
 * @returns {string}
 */
export function normalizeVisibility(value, catelog = '') {
  const visibility = cleanText(value).toLowerCase();
  if (SITE_VISIBILITIES.includes(visibility)) return visibility;
  return cleanText(catelog) === PRIVATE_BOOKMARK_CATEGORY ? 'private' : 'public';
}

/**
 * 判断站点是否属于私密书签。
 *
 * @param {object|null|undefined} site 站点记录。
 * @returns {boolean}
 */
export function isPrivateSite(site) {
  return normalizeVisibility(site?.visibility, site?.catelog) === 'private' || cleanText(site?.catelog) === PRIVATE_BOOKMARK_CATEGORY;
}

/**
 * 判断当前访问上下文是否允许查看站点详情。
 *
 * `unlisted` 允许知道直链时访问，`admin_only` 仅管理员可访问，`private` 需要私密访问态。
 *
 * @param {object|null|undefined} site 站点记录。
 * @param {{ adminAuthed?: boolean, privateUnlocked?: boolean }} [options] 访问上下文（或上下文对象）。
 * @returns {boolean}
 */
export function canAccessSite(site, { adminAuthed = false, privateUnlocked = false } = {}) {
  const visibility = normalizeVisibility(site?.visibility, site?.catelog);
  if (adminAuthed) return true;
  if (visibility === 'admin_only') return false;
  if (visibility === 'private' || cleanText(site?.catelog) === PRIVATE_BOOKMARK_CATEGORY) return privateUnlocked;
  return true;
}

/**
 * 判断站点是否可出现在公开列表 / 搜索结果中。
 *
 * 与 `canAccessSite` 的区别是：`unlisted` 不进入列表，但仍可在已知直链场景下访问。
 *
 * @param {object|null|undefined} site 站点记录。
 * @param {{ adminAuthed?: boolean, privateUnlocked?: boolean }} [options] 访问上下文（或上下文对象）。
 * @returns {boolean}
 */
export function canListSite(site, { adminAuthed = false, privateUnlocked = false } = {}) {
  const visibility = normalizeVisibility(site?.visibility, site?.catelog);
  if (adminAuthed) return true;
  if (visibility === 'unlisted' || visibility === 'admin_only') return false;
  return canAccessSite(site, { adminAuthed, privateUnlocked });
}

/**
 * 渲染站点可见性过滤的 SQL 片段（访问规则与 SQL 渲染的单一来源）。
 *
 * 与 `canListSite` 等价规则的 SQL 形态：admin 不过滤；私人书签解锁可见
 * public/private；否则仅 public 且排除私密分类。消费方（siteService 的
 * 6 处列表/搜索查询）只 push 返回的 sql 与 binds，不再各自复制谓词。
 *
 * @param {{ adminAuthed?: boolean, privateUnlocked?: boolean }|null} [access] 访问上下文。
 * @returns {{ sql: string, binds: string[] }} sql 为空串表示无需过滤。
 */
export function visibilityWhere(access = {}) {
  if (access?.adminAuthed) return { sql: '', binds: [] };
  if (access?.privateUnlocked) {
    return { sql: "COALESCE(s.visibility, 'public') IN ('public', 'private')", binds: [] };
  }
  return {
    sql: "COALESCE(s.visibility, 'public') = 'public' AND COALESCE(c.name, s.catelog) <> ?",
    binds: [PRIVATE_BOOKMARK_CATEGORY],
  };
}
