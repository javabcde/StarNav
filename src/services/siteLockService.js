import { clearLoginFailures, registerLoginFailure } from '../lib/auth.js';
import { cleanText } from '../lib/utils.js';
import { deleteSetting, getSettingRecord, setSetting } from './settingsService.js';
import { createUnlockSessionManager } from './unlockSessionService.js';

/**
 * 整站锁（Site Lock）：部署级访问门禁。
 * 默认关闭——未配置密码即不生效；配置密码后，除白名单路由外的所有路由
 * 都需要解锁会话或管理员会话才能访问（见 src/handlers/siteLock.js）。
 *
 * 解锁会话机制（PBKDF2 密码哈希 / KV token / 滑动续期 / Cookie / 时长词汇）
 * 收归 unlockSessionService（createUnlockSessionManager 实例）；本模块保留
 * 策略：cookie 名、KV 前缀、setting key、试错限速、锁状态 KV 缓存、密码即开关。
 */

export const SITE_LOCK_COOKIE_NAME = 'nav_site_lock';
export const SITE_LOCK_MIN_PASSWORD_LENGTH = 4;

const SITE_LOCK_ACCESS_TOKEN_PREFIX = 'site-lock:access:';
const SITE_LOCK_PASSWORD_SETTING_KEY = 'site_lock_password';
const SITE_LOCK_STATE_KV_KEY = 'site_lock:enabled';
// 锁状态 KV 缓存 TTL：写锁设置时同步 put（秒级全局生效），TTL 仅兜底
// “DB 被外部直接修改”等失步场景（最多滞后一个 TTL 自愈）。
const SITE_LOCK_STATE_TTL_SECONDS = 60;

// 解锁会话机制实例（策略参数绑定本模块；导出面保持原样）
const unlockSession = createUnlockSessionManager({
  cookieName: SITE_LOCK_COOKIE_NAME,
  tokenPrefix: SITE_LOCK_ACCESS_TOKEN_PREFIX,
  settingKey: SITE_LOCK_PASSWORD_SETTING_KEY,
  requireEnabledCheck: true,
});

// ── 试错限速（独立于后台登录的计数）────────────────────────────────────
const SITE_LOCK_THROTTLE_PREFIX = 'site-lock:throttle:';
const SITE_LOCK_MAX_ATTEMPTS = 5;
const SITE_LOCK_LOCKOUT_SECONDS = 15 * 60;

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';
}

/**
 * 读取当前客户端 IP 的整站锁密码失败状态（与后台登录计数相互独立）。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {Request} request 当前请求。
 * @returns {Promise<{ip: string, key: string, count: number, locked: boolean}>}
 */
export async function getSiteLockThrottle(env, request) {
  const ip = getClientIp(request);
  const key = `${SITE_LOCK_THROTTLE_PREFIX}${ip}`;
  const raw = await env.NAV_AUTH.get(key);
  let count = 0;
  if (raw) {
    try {
      count = Number(JSON.parse(raw).count) || 0;
    } catch {
      count = 0;
    }
  }
  return { ip, key, count, locked: count >= SITE_LOCK_MAX_ATTEMPTS };
}

/**
 * 记录一次整站锁密码失败，并刷新锁定窗口 TTL（持续失败则持续锁定）。
 * 复用 auth.js 的 registerLoginFailure（同样的计数/过期语义），仅 key 前缀不同。
 */
export async function registerSiteLockFailure(env, key, currentCount = 0) {
  await registerLoginFailure(env, key, currentCount);
}

/**
 * 整站锁密码验证成功后清除失败计数。
 */
export async function clearSiteLockFailures(env, key) {
  await clearLoginFailures(env, key);
}

/**
 * 整站锁是否启用：配置了非空密码即为启用（密码即开关，无独立开关）。
 * 锁状态缓存在 KV：命中即省一次 D1 读；写锁设置（update/clear）时同步刷新。
 */
export async function isSiteLockEnabled(env) {
  const cached = await env?.NAV_AUTH?.get?.(SITE_LOCK_STATE_KV_KEY, 'text');
  if (cached === '1') return true;
  if (cached === '0') return false;

  const record = await getSettingRecord(env, SITE_LOCK_PASSWORD_SETTING_KEY, '');
  const enabled = record.exists && Boolean(cleanText(record.value));
  await cacheSiteLockState(env, enabled);
  return enabled;
}

/**
 * 将锁状态写入 KV 缓存（失败仅告警，不影响主流程）。
 */
async function cacheSiteLockState(env, enabled) {
  try {
    await env?.NAV_AUTH?.put?.(SITE_LOCK_STATE_KV_KEY, enabled ? '1' : '0', { expirationTtl: SITE_LOCK_STATE_TTL_SECONDS });
  } catch (error) {
    console.warn(`[siteLockService] cache lock state failed: ${error?.message || error}`);
  }
}

/**
 * 设置/修改整站锁密码（最少 4 位）。修改后立即使全部已发解锁会话失效。
 *
 * @param {object} env Cloudflare Workers 环境绑定。
 * @param {string} password 新密码明文。
 * @throws {Error} 密码少于 SITE_LOCK_MIN_PASSWORD_LENGTH 位时抛出。
 */
export async function updateSiteLockPassword(env, password) {
  const normalized = cleanText(password);
  if (normalized.length < SITE_LOCK_MIN_PASSWORD_LENGTH) {
    throw new Error(`Site lock password must be at least ${SITE_LOCK_MIN_PASSWORD_LENGTH} characters`);
  }
  await setSetting(env, SITE_LOCK_PASSWORD_SETTING_KEY, await unlockSession.hashPassword(normalized));
  await unlockSession.clearAllTokens(env);
  await cacheSiteLockState(env, true);
}

/**
 * 清除整站锁密码并关闭锁（显式操作），同时使全部已发解锁会话失效。
 */
export async function clearSiteLockPassword(env) {
  await deleteSetting(env, SITE_LOCK_PASSWORD_SETTING_KEY);
  await unlockSession.clearAllTokens(env);
  await cacheSiteLockState(env, false);
}

/**
 * 校验整站锁密码。兼容历史明文存储（命中后自动升级为 PBKDF2 哈希）。
 * 密码即开关：锁未启用（无密码）时一律拒绝。
 */
export async function verifySiteLockPassword(env, password) {
  return unlockSession.verifyPassword(env, password, {
    enabledCheck: () => isSiteLockEnabled(env),
  });
}

// ── 解锁会话（机制在 unlockSessionService，此处为策略绑定 + 原导出面）──

export const siteLockDurationOptions = unlockSession.durationOptions;

export function normalizeSiteLockDuration(value) {
  return unlockSession.normalizeDuration(value);
}

export function getSiteLockAccessTtlSeconds(durationKey) {
  return unlockSession.getTtlSeconds(durationKey);
}

export async function createSiteLockAccess(env, { duration = '12h' } = {}) {
  return unlockSession.createAccess(env, { duration });
}

export function buildSiteLockAccessCookie(token, options = {}) {
  return unlockSession.buildCookie(token, options);
}

export function buildClearSiteLockAccessCookie() {
  return unlockSession.buildClearCookie();
}

export async function clearSiteLockAccessTokens(env) {
  await unlockSession.clearAllTokens(env);
}

export async function hasSiteLockAccess(request, env) {
  return unlockSession.hasAccess(request, env);
}

export async function revokeCurrentSiteLockAccess(request, env) {
  await unlockSession.revokeCurrent(request, env);
}
