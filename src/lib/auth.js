import { constantTimeCompare, hashPassword, verifyPasswordHash } from './crypto.js';
import { createIpThrottle } from './ipThrottle.js';

// 管理员会话（session 机制 / WeakMap 缓存）已迁入 services/unlockSessionService.js
// （2026-08-16 架构评审候选 5，与解锁会话同族同模块）；re-export 垫片保持存量测试
// 与调用方 import 面不变，同 ADR-0003 模式。lib→services 边有 edgeCache→accessService 先例。
export {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  createAdminSession,
  refreshAdminSession,
  destroyAdminSession,
  validateAdminSession,
  isAdminAuthenticated,
} from '../services/unlockSessionService.js';

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