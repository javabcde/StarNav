import { clearLoginFailures, parseCookies, registerLoginFailure } from '../lib/auth.js';
import { cleanText } from '../lib/utils.js';
import { deleteSetting, getSettingRecord, setSetting } from './settingsService.js';

/**
 * 整站锁（Site Lock）：部署级访问门禁。
 * 默认关闭——未配置密码即不生效；配置密码后，除白名单路由外的所有路由
 * 都需要解锁会话或管理员会话才能访问（见 src/handlers/siteLock.js）。
 *
 * 实现模式与 privateBookmarkService 保持一致：PBKDF2 密码哈希存 D1 settings，
 * 解锁 token 随机生成存 KV（NAV_AUTH），Cookie 携带，可滑动续期、可主动退出。
 */

export const SITE_LOCK_COOKIE_NAME = 'nav_site_lock';
export const SITE_LOCK_MIN_PASSWORD_LENGTH = 4;

const SITE_LOCK_ACCESS_TOKEN_PREFIX = 'site-lock:access:';
const SITE_LOCK_PASSWORD_SETTING_KEY = 'site_lock_password';
const SITE_LOCK_TTL_SECONDS = 60 * 60 * 12;
const SITE_LOCK_TTL_OPTIONS = {
  session: 60 * 60 * 24,
  '1h': 60 * 60,
  '12h': 60 * 60 * 12,
  '7d': 60 * 60 * 24 * 7,
  '30d': 60 * 60 * 24 * 30,
};
const PASSWORD_HASH_PREFIX = 'pbkdf2';
const PASSWORD_HASH_ITERATIONS = 100000;

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

// ── 密码存储 ──────────────────────────────────────────────────────────

function bytesToBase64(bytes) {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (!(a instanceof Uint8Array)) a = new Uint8Array(a);
  if (!(b instanceof Uint8Array)) b = new Uint8Array(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isHashedPassword(value) {
  return cleanText(value).startsWith(`${PASSWORD_HASH_PREFIX}$`);
}

async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_HASH_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return `${PASSWORD_HASH_PREFIX}$sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

async function verifyPasswordHash(password, storedHash) {
  const parts = cleanText(storedHash).split('$');
  if (parts.length !== 5 || parts[0] !== PASSWORD_HASH_PREFIX || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 10000) return false;

  const salt = base64ToBytes(parts[3]);
  const expected = base64ToBytes(parts[4]);
  const nextHash = await hashPassword(password, salt, iterations);
  const actual = base64ToBytes(nextHash.split('$')[4]);
  return timingSafeEqual(actual, expected);
}

/**
 * 整站锁是否启用：配置了非空密码即为启用（密码即开关，无独立开关）。
 */
export async function isSiteLockEnabled(env) {
  const record = await getSettingRecord(env, SITE_LOCK_PASSWORD_SETTING_KEY, '');
  return record.exists && Boolean(cleanText(record.value));
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
  await setSetting(env, SITE_LOCK_PASSWORD_SETTING_KEY, await hashPassword(normalized));
  await clearSiteLockAccessTokens(env);
}

/**
 * 清除整站锁密码并关闭锁（显式操作），同时使全部已发解锁会话失效。
 */
export async function clearSiteLockPassword(env) {
  await deleteSetting(env, SITE_LOCK_PASSWORD_SETTING_KEY);
  await clearSiteLockAccessTokens(env);
}

/**
 * 校验整站锁密码。兼容历史明文存储（命中后自动升级为 PBKDF2 哈希）。
 */
export async function verifySiteLockPassword(env, password) {
  const normalized = cleanText(password);
  if (!normalized || !(await isSiteLockEnabled(env))) return false;

  const record = await getSettingRecord(env, SITE_LOCK_PASSWORD_SETTING_KEY, '');
  if (isHashedPassword(record.value)) {
    return verifyPasswordHash(normalized, record.value);
  }

  const matched = normalized === record.value;
  if (matched) {
    await setSetting(env, SITE_LOCK_PASSWORD_SETTING_KEY, await hashPassword(normalized));
  }
  return matched;
}

// ── 解锁会话 ──────────────────────────────────────────────────────────

export function normalizeSiteLockDuration(value) {
  const key = cleanText(value).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SITE_LOCK_TTL_OPTIONS, key)) return key;
  return '12h';
}

export function getSiteLockAccessTtlSeconds(durationKey) {
  return SITE_LOCK_TTL_OPTIONS[normalizeSiteLockDuration(durationKey)] || SITE_LOCK_TTL_SECONDS;
}

/**
 * 创建解锁会话：随机 token 写入 KV（TTL 对应所选时长），返回 token/ttl/duration。
 */
export async function createSiteLockAccess(env, { duration = '12h' } = {}) {
  const token = crypto.randomUUID();
  const ttl = getSiteLockAccessTtlSeconds(duration);
  await env.NAV_AUTH.put(`${SITE_LOCK_ACCESS_TOKEN_PREFIX}${token}`, JSON.stringify({ createdAt: Date.now(), duration: normalizeSiteLockDuration(duration), ttl }), {
    expirationTtl: ttl,
  });
  return { token, ttl, duration: normalizeSiteLockDuration(duration) };
}

/**
 * 构建解锁 Cookie（nav_site_lock）。session 时长不写 Max-Age（浏览器关闭即失效）。
 */
export function buildSiteLockAccessCookie(token, options = {}) {
  const { maxAge = SITE_LOCK_TTL_SECONDS, duration } = options;
  const parts = [
    `${SITE_LOCK_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Secure',
  ];
  if (duration !== 'session') {
    parts.push(`Max-Age=${maxAge}`);
  }
  return parts.join('; ');
}

export function buildClearSiteLockAccessCookie() {
  return buildSiteLockAccessCookie('', { maxAge: 0 });
}

/**
 * 撤销全部已发解锁会话（改密码/关锁时调用）。
 */
export async function clearSiteLockAccessTokens(env) {
  let cursor;
  do {
    const list = await env.NAV_AUTH.list({ prefix: SITE_LOCK_ACCESS_TOKEN_PREFIX, cursor });
    await Promise.all((list.keys || []).map((item) => env.NAV_AUTH.delete(item.name)));
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}

/**
 * 判断当前请求是否持有有效解锁会话（KV token 存在即有效，并滑动续期）。
 */
export async function hasSiteLockAccess(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[SITE_LOCK_COOKIE_NAME];
  if (!token) return false;

  const sessionKey = `${SITE_LOCK_ACCESS_TOKEN_PREFIX}${token}`;
  const payload = await env.NAV_AUTH.get(sessionKey);
  if (!payload) return false;

  // 滑动续期：根据当前 token 的原始 ttl 续期；解析失败则回退到默认 12h
  let renewTtl = SITE_LOCK_TTL_SECONDS;
  try {
    const parsed = JSON.parse(payload);
    if (Number.isFinite(Number(parsed?.ttl))) renewTtl = Number(parsed.ttl);
  } catch {
    // 兼容旧 payload 格式
  }
  await env.NAV_AUTH.put(sessionKey, payload, { expirationTtl: renewTtl });
  return true;
}

/**
 * 撤销当前请求持有的解锁会话（退出解锁）。
 */
export async function revokeCurrentSiteLockAccess(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[SITE_LOCK_COOKIE_NAME];
  if (token) await env.NAV_AUTH.delete(`${SITE_LOCK_ACCESS_TOKEN_PREFIX}${token}`);
}
