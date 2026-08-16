import { constantTimeCompare, hashPassword, verifyPasswordHash } from './crypto.js';
import { createIpThrottle } from './ipThrottle.js';
import { buildSessionCookie as buildCookieString, shouldRenew } from './sessionPolicy.js';
import { parseCookies } from './cookie.js';
import {
  createApiToken,
  hasBearerToken,
  listApiTokens,
  revokeApiToken,
  tokenHasScope,
  validateApiToken,
} from './apiTokenService.js';

export const SESSION_COOKIE_NAME = 'nav_admin_session';
const SESSION_PREFIX = 'session:';
const SESSION_TTL_SECONDS = 60 * 60 * 12;
const SESSION_ABSOLUTE_TTL_SECONDS = 60 * 60 * 24 * 7; // 会话绝对存活上限：7 天（即使持续活跃也会过期）
const PASSWORD_HASH_PREFIX = 'pbkdf2$';
const PASSWORD_HASH_ITERATIONS = 100000;
const PASSWORD_HASH_KEYLEN = 32;


// API Token 域已迁入 lib/apiTokenService.js（2026-08-16 架构评审候选 6）；
// Cookie 解析已迁入 lib/cookie.js（同一语义收编）。re-export 垫片保持存量测试
// 与调用方 import 面不变，同 ADR-0003 模式（lib→lib，无方向违规）。
export {
  createApiToken,
  hasBearerToken,
  listApiTokens,
  revokeApiToken,
  tokenHasScope,
  validateApiToken,
} from './apiTokenService.js';
export { parseCookies } from './cookie.js';
/**
 * @typedef {object} AuthResult
 * @property {boolean} authenticated 是否鉴权成功。
 * @property {boolean} [forbidden] 是否已识别身份但权限范围不足。
 * @property {string|ApiTokenPublicRecord} [token] session token 或脱敏后的 API Token 信息。
 */




/**
 * 构建后台管理员 session Cookie。
 *
 * @param {string} token session token。
 * @param {object} [options] Cookie 选项。
 * @param {number} [options.maxAge=SESSION_TTL_SECONDS] Cookie 有效期，单位秒。
 * @returns {string}
 */
export function buildSessionCookie(token, options = {}) {
  const { maxAge = SESSION_TTL_SECONDS } = options;
  // 属性集（Path/Max-Age/HttpOnly/SameSite、不设 Secure）收编 lib/sessionPolicy.js
  return buildCookieString(SESSION_COOKIE_NAME, token, { maxAge });
}

/**
 * 创建后台管理员 session，并写入 KV。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @returns {Promise<string>} 新创建的 session token。
 */
export async function createAdminSession(env) {
  const token = crypto.randomUUID();
  await env.NAV_AUTH.put(`${SESSION_PREFIX}${token}`, JSON.stringify({ createdAt: Date.now() }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

/**
 * 刷新后台管理员 session TTL。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {string} token session token。
 * @param {string} payload 原始 session payload。
 * @returns {Promise<void>}
 */
export async function refreshAdminSession(env, token, payload) {
  await env.NAV_AUTH.put(`${SESSION_PREFIX}${token}`, payload, { expirationTtl: SESSION_TTL_SECONDS });
}

/**
 * 销毁后台管理员 session。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {string} token session token。
 * @returns {Promise<void>}
 */
export async function destroyAdminSession(env, token) {
  if (!token) return;
  await env.NAV_AUTH.delete(`${SESSION_PREFIX}${token}`);
}

/**
 * 校验请求中的后台管理员 session Cookie。
 *
 * 校验成功时会自动刷新 session TTL。
 *
 * @param {Request} request 当前请求。
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @returns {Promise<AuthResult>}
 */
export async function validateAdminSession(request, env) {
  const cookies = parseCookies(request.headers.get('Cookie') || '');
  const token = cookies[SESSION_COOKIE_NAME];
  if (!token) return { authenticated: false };

  const sessionKey = `${SESSION_PREFIX}${token}`;
  const payload = await env.NAV_AUTH.get(sessionKey);
  if (!payload) return { authenticated: false };

  // 绝对过期：即使持续活跃，会话最长存活 SESSION_ABSOLUTE_TTL_SECONDS，限制被盗会话的滥用窗口
  let parsedPayload = null;
  try {
    parsedPayload = JSON.parse(payload);
  } catch {
    parsedPayload = null;
  }
  const createdAt = Number(parsedPayload?.createdAt) || 0;
  if (createdAt && Date.now() - createdAt > SESSION_ABSOLUTE_TTL_SECONDS * 1000) {
    await destroyAdminSession(env, token);
    return { authenticated: false };
  }

  // 滑动续期降频：距上次续期不足 SESSION_TTL_SECONDS/2 时跳过 KV 写。
  // KV 内 TTL 仍有 ≥ 一半余量，会话不会提前过期；持续活跃的会话每半个
  // 滑动窗口续期一次，KV 写从每请求 1 次降到约每 6 小时 1 次。
  const now = Date.now();
  if (shouldRenew({ createdAt, refreshedAt: parsedPayload?.lastRefresh, ttlMs: SESSION_TTL_SECONDS * 1000, now })) {
    if (parsedPayload) {
      await refreshAdminSession(env, token, JSON.stringify({ ...parsedPayload, lastRefresh: now }));
    } else {
      await refreshAdminSession(env, token, payload); // 解析失败保持原样续期
    }
  }
  return { authenticated: true, token };
}

// 请求级 admin 鉴权结果缓存：锁中间件与页面/API handler 在同一请求内
// 多次调用 isAdminAuthenticated 时只做一次 KV 读。WeakMap 键为 Request 对象，
// 请求结束即随对象回收，无跨请求泄漏。
const adminAuthCache = new WeakMap();

/**
 * 判断当前请求是否已通过后台管理员鉴权。
 *
 * @param {Request} request 当前请求。
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @returns {Promise<boolean>}
 */
export async function isAdminAuthenticated(request, env) {
  const cached = adminAuthCache.get(request);
  if (cached !== undefined) return cached;
  const promise = validateAdminSession(request, env)
    .then((result) => result.authenticated)
    .catch(() => false);
  adminAuthCache.set(request, promise);
  return promise;
}


// ── 管理员密码哈希 ────────────────────────────────────────────────────
// 新哈希一律规范五段格式（crypto.js hashPassword：pbkdf2$sha256$100000$<salt-b64>$<hash-b64>，
// 常量时间比较内置于 verifyPasswordHash）。历史两代格式在登录时兼容校验并原地升级：
//   - 旧版明文：命中后升级为规范哈希；
//   - 旧 hex 双段格式 pbkdf2$<salt-hex>$<hash-hex>：用旧算法常量时间校验，命中后原地升级。

/**
 * 旧 hex 双段格式的哈希段派生（PBKDF2-SHA256，100k 迭代，输出 hex）。
 * 仅用于校验历史存储值，不再用于新写入。
 *
 * @param {string} password 明文密码。
 * @param {string} salt 旧格式 hex 盐。
 * @returns {Promise<string>} hex 摘要。
 */
async function legacyHashPasswordHex(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: PASSWORD_HASH_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    PASSWORD_HASH_KEYLEN * 8
  );
  const hashArray = Array.from(new Uint8Array(derivedBits));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}


/**
 * 校验后台管理员用户名和密码。
 *
 * 密码存储三态兼容，命中正确密码后统一升级为规范五段格式（crypto.js）：
 * 明文 → 旧 hex 双段哈希 → 规范五段哈希。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {string} name 管理员用户名。
 * @param {string} password 管理员密码。
 * @returns {Promise<boolean>} 凭据是否有效。
 */
export async function verifyAdminCredentials(env, name, password) {
  const storedUsername = await env.NAV_AUTH.get('admin_username');
  const storedPasswordData = await env.NAV_AUTH.get('admin_password');

  if (!storedUsername || !storedPasswordData) return false;
  if (String(name || '').trim() !== storedUsername) return false;

  const trimmedPassword = String(password || '').trim();

  // 兼容旧版明文密码（首次登录后自动升级为规范哈希）
  if (!storedPasswordData.startsWith(PASSWORD_HASH_PREFIX)) {
    const isValid = trimmedPassword === storedPasswordData;
    if (isValid) {
      // 自动升级为哈希存储（规范五段格式，随机盐）
      await env.NAV_AUTH.put('admin_password', await hashPassword(trimmedPassword));
      console.log('[auth] Password upgraded to hashed format');
    }
    return isValid;
  }

  const segments = storedPasswordData.split('$');
  if (segments.length === 3) {
    // 旧 hex 双段格式（pbkdf2$<salt-hex>$<hash-hex>）：旧算法常量时间校验，命中后原地升级
    const [, salt, storedHash] = segments;
    const computedHash = await legacyHashPasswordHex(trimmedPassword, salt);
    const isValid = await constantTimeCompare(computedHash, storedHash);
    if (isValid) {
      await env.NAV_AUTH.put('admin_password', await hashPassword(trimmedPassword));
      console.log('[auth] Password upgraded to canonical pbkdf2 format');
    }
    return isValid;
  }

  // 规范五段格式：crypto.verifyPasswordHash（格式/迭代数校验 + 常量时间比较）
  return verifyPasswordHash(trimmedPassword, storedPasswordData);
}

// ── 登录失败限速（缓解后台登录在线爆破，#1）────────────────────────────
// 机制（IP 提取 / 计数 / TTL）收编 lib/ipThrottle.js；此处绑定后台登录策略
// （login_fail: 前缀、5 次 / 15 分钟），导出面与 KV 布局保持不变。
const LOGIN_FAIL_PREFIX = 'login_fail:';
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_SECONDS = 15 * 60;

const loginThrottle = createIpThrottle({
  prefix: LOGIN_FAIL_PREFIX,
  maxAttempts: LOGIN_MAX_ATTEMPTS,
  lockoutSeconds: LOGIN_LOCKOUT_SECONDS,
});

/**
 * 读取当前客户端 IP 的登录失败状态。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {Request} request 当前请求。
 * @returns {Promise<{ip: string, key: string, count: number, locked: boolean}>}
 */
export function getLoginThrottle(env, request) {
  return loginThrottle.get(env, request);
}

/**
 * 记录一次登录失败，并刷新锁定窗口 TTL（持续失败则持续锁定）。
 *
 * @param {object} env Cloudflare Workers 环境绑定。
 * @param {string} key getLoginThrottle 返回的 KV key。
 * @param {number} [currentCount=0] 当前已知失败次数。
 * @returns {Promise<void>}
 */
export async function registerLoginFailure(env, key, currentCount = 0) {
  await loginThrottle.register(env, key, currentCount);
}

/**
 * 登录成功后清除失败计数。
 *
 * @param {object} env Cloudflare Workers 环境绑定。
 * @param {string} key getLoginThrottle 返回的 KV key。
 * @returns {Promise<void>}
 */
export async function clearLoginFailures(env, key) {
  await loginThrottle.clear(env, key);
}