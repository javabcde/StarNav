// 解锁会话核心（Unlock Session Core）：整站锁与私人书签共用的访问凭据机制。
// 一个参数化工厂，两个 adapter（siteLockService / privateBookmarkService）各持实例。
// 机制：密码 PBKDF2 校验（含历史明文自动升级，哈希段在 lib/crypto.js）、
// 随机 token 存 KV（NAV_AUTH）、Cookie 携带、滑动续期、可主动退出。
// 策略（cookie 名 / KV 前缀 / setting key / 限速 / 状态缓存 / 分类常量）留在 adapter。
import { parseCookies } from '../lib/auth.js';
import {
  hashPassword,
  isHashedPassword,
  verifyPasswordHash,
} from '../lib/crypto.js';
import { cleanText } from '../lib/utils.js';
import { getSettingRecord, setSetting } from './settingsService.js';

// 时长档位（session/1h/12h/7d/30d）与默认档位：解锁会话的共享词汇。
export const DEFAULT_TTL_OPTIONS = {
  session: 60 * 60 * 24,
  '1h': 60 * 60,
  '12h': 60 * 60 * 12,
  '7d': 60 * 60 * 24 * 7,
  '30d': 60 * 60 * 24 * 30,
};
export const DEFAULT_DURATION = '12h';

/**
 * 创建解锁会话管理器。
 *
 * @param {object} config
 * @param {string} config.cookieName 解锁 Cookie 名（策略，adapter 持有）。
 * @param {string} config.tokenPrefix KV token 前缀（策略，adapter 持有）。
 * @param {string} config.settingKey D1 settings 密码键名（策略，adapter 持有）。
 * @param {(env: object) => string} [config.passwordFallback] 密码记录的 fallback 值（如 env 变量/默认密码）。
 * @param {boolean} [config.requireEnabledCheck] 校验密码前先过 enabledCheck（整站锁「密码即开关」语义）。
 * @returns {object} 解锁会话机制 API。
 */
export function createUnlockSessionManager({
  cookieName,
  tokenPrefix,
  settingKey,
  passwordFallback = () => '',
  requireEnabledCheck = false,
}) {
  const DEFAULT_TTL_SECONDS = DEFAULT_TTL_OPTIONS[DEFAULT_DURATION];

  /**
   * 时长档位表（含默认标记）：锁页 `<select>` 与 TTL 换算共用同一词汇。
   * @returns {Array<{key: string, label: string, default?: boolean}>}
   */
  const durationOptions = Object.keys(DEFAULT_TTL_OPTIONS).map((key) => ({
    key,
    label: durationLabel(key),
    default: key === DEFAULT_DURATION ? true : undefined,
  }));

  function durationLabel(key) {
    const labels = {
      session: '仅本次会话',
      '1h': '1 小时',
      '12h': '12 小时',
      '7d': '7 天',
      '30d': '30 天',
    };
    return labels[key] || key;
  }

  function normalizeDuration(value) {
    const key = cleanText(value).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(DEFAULT_TTL_OPTIONS, key)) return key;
    return DEFAULT_DURATION;
  }

  function getTtlSeconds(durationKey) {
    return DEFAULT_TTL_OPTIONS[normalizeDuration(durationKey)] || DEFAULT_TTL_SECONDS;
  }

  /**
   * 创建解锁会话：随机 token 写入 KV（TTL 对应所选时长）。
   * @returns {Promise<{token: string, ttl: number, duration: string}>}
   */
  async function createAccess(env, { duration = DEFAULT_DURATION } = {}) {
    const token = crypto.randomUUID();
    const ttl = getTtlSeconds(duration);
    const normalized = normalizeDuration(duration);
    await env.NAV_AUTH.put(`${tokenPrefix}${token}`, JSON.stringify({ createdAt: Date.now(), duration: normalized, ttl }), {
      expirationTtl: ttl,
    });
    return { token, ttl, duration: normalized };
  }

  /**
   * 构建解锁 Cookie。session 时长不写 Max-Age（浏览器关闭即失效）。
   */
  function buildCookie(token, options = {}) {
    const { maxAge = DEFAULT_TTL_SECONDS, duration } = options;
    const parts = [
      `${cookieName}=${token}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      // 不设 Secure：夸克/VIA 等移动浏览器会丢弃带 Secure 的 Cookie（探针实测）。
      // 站点为 https-only（CF 自定义域名），去掉无实际安全损失。
    ];
    if (duration !== 'session') {
      parts.push(`Max-Age=${maxAge}`);
    }
    return parts.join('; ');
  }

  function buildClearCookie() {
    return buildCookie('', { maxAge: 0 });
  }

  /**
   * 撤销全部已发解锁会话（改密码/关闭时调用）。
   */
  async function clearAllTokens(env) {
    let cursor;
    do {
      const list = await env.NAV_AUTH.list({ prefix: tokenPrefix, cursor });
      await Promise.all((list.keys || []).map((item) => env.NAV_AUTH.delete(item.name)));
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }

  /**
   * 判断当前请求是否持有有效解锁会话（KV token 存在即有效，并滑动续期）。
   * 续期降频：剩余时间 > TTL 一半时跳过 KV 写（每请求 1 写 → 约每 TTL/2 1 写）。
   */
  async function hasAccess(request, env) {
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const token = cookies[cookieName];
    if (!token) return false;

    const sessionKey = `${tokenPrefix}${token}`;
    const payload = await env.NAV_AUTH.get(sessionKey);
    if (!payload) return false;

    let renewTtl = DEFAULT_TTL_SECONDS;
    let createdAt = 0;
    try {
      const parsed = JSON.parse(payload);
      if (Number.isFinite(Number(parsed?.ttl))) renewTtl = Number(parsed.ttl);
      createdAt = Number(parsed?.createdAt) || 0;
    } catch {
      // 兼容旧 payload 格式
    }
    const remainingMs = createdAt ? createdAt + renewTtl * 1000 - Date.now() : 0;
    if (!createdAt || remainingMs <= (renewTtl * 1000) / 2) {
      await env.NAV_AUTH.put(sessionKey, payload, { expirationTtl: renewTtl });
    }
    return true;
  }

  /**
   * 撤销当前请求持有的解锁会话（退出解锁）。
   */
  async function revokeCurrent(request, env) {
    const cookies = parseCookies(request.headers.get('Cookie') || '');
    const token = cookies[cookieName];
    if (token) await env.NAV_AUTH.delete(`${tokenPrefix}${token}`);
  }

  /**
   * 校验密码。兼容历史明文存储（命中后自动升级为 PBKDF2 哈希）。
   * requireEnabledCheck 时先过 enabledCheck（整站锁「密码即开关」）。
   */
  async function verifyPassword(env, password, { enabledCheck = null } = {}) {
    const normalized = cleanText(password);
    if (!normalized) return false;
    if (requireEnabledCheck && enabledCheck && !(await enabledCheck(env))) return false;

    const record = await getSettingRecord(env, settingKey, passwordFallback(env));
    const raw = record.value;
    const stored = cleanText(raw);
    if (isHashedPassword(stored)) {
      return verifyPasswordHash(normalized, stored);
    }

    // 兼容两种历史明文比较语义：private 侧原为 cleanText 比较、siteLock 侧原为 raw 比较。
    // 正常写入路径（update*Password 先 cleanText）下两者等价；脏数据边界（外部直写带空白明文）
    // 下任一命中即接受并自动升级为哈希。
    const matched = normalized === stored || normalized === raw;
    if (matched) {
      await setSetting(env, settingKey, await hashPassword(normalized));
    }
    return matched;
  }

  return {
    durationOptions,
    normalizeDuration,
    getTtlSeconds,
    createAccess,
    buildCookie,
    buildClearCookie,
    clearAllTokens,
    hasAccess,
    revokeCurrent,
    verifyPassword,
    // 密码哈希段（crypto.js re-export）：adapter 的 update*Password 路径使用
    hashPassword,
    isHashedPassword,
    verifyPasswordHash,
  };
}
