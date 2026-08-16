// 会话策略纯函数：管理员会话（lib/auth.js）与解锁会话（services/unlockSessionService.js）
// 共用的 Cookie 构建与滑动续期降频判定。策略参数（cookie 名 / 默认 Max-Age / TTL /
// 绝对上限）由调用方持有，本模块只做无副作用的拼装与时间窗口判定。

/**
 * 构建会话 Cookie 串。属性集统一：Path=/、（非 session 档）Max-Age、HttpOnly、
 * SameSite=Strict、不设 Secure——夸克/VIA 等移动浏览器会丢弃带 Secure 的 Cookie
 * （探针实测）；站点为 https-only（CF 自定义域名），去掉无实际安全损失。
 * duration === 'session' 时不写 Max-Age（浏览器关闭即失效）。
 *
 * @param {string} name Cookie 名。
 * @param {string} token Cookie 值（清除语义时传空串 + maxAge 0）。
 * @param {object} [options]
 * @param {number} [options.maxAge=0] Max-Age 秒数；缺省 0 即清除 Cookie 语义。
 * @param {string} [options.duration] 时长档位，'session' 表示会话 Cookie（不写 Max-Age）。
 * @returns {string}
 */
export function buildSessionCookie(name, token, { maxAge = 0, duration } = {}) {
  const parts = [
    `${name}=${token}`,
    'Path=/',
  ];
  if (duration !== 'session') {
    parts.push(`Max-Age=${maxAge}`);
  }
  parts.push('HttpOnly', 'SameSite=Strict');
  return parts.join('; ');
}

/**
 * 滑动续期降频判定（「降频窗口」）：距锚点不足半窗口时跳过续期写。
 * 锚点取 refreshedAt（最近一次续期），缺省回落 createdAt；两者皆缺失时保守续期。
 * KV 内 TTL 仍有 ≥ 一半余量，跳过写不会导致会话提前过期；持续活跃的会话每半个
 * 滑动窗口才续期一次，KV 写从每请求 1 次降到约每 TTL/2 一次。
 *
 * @param {object} input
 * @param {number} input.createdAt 会话创建时间戳（ms）。
 * @param {number} [input.refreshedAt] 最近一次续期时间戳（ms），缺省回落 createdAt。
 * @param {number} input.ttlMs 滑动窗口时长（ms）。
 * @param {number} input.now 当前时间戳（ms）。
 * @returns {boolean} true = 需要执行续期写。
 */
export function shouldRenew({ createdAt, refreshedAt, ttlMs, now }) {
  const anchor = Number(refreshedAt) || Number(createdAt) || 0;
  if (!anchor) return true;
  return now - anchor >= ttlMs / 2;
}
