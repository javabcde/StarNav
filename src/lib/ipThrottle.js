// IP 级试错限速（KV 计数 + 锁定窗口）：后台登录（lib/auth.js）与整站锁
// （services/siteLockService.js）共用机制，各持一个实例（key 前缀 / 阈值 /
// 窗口为策略参数），计数互不干扰。payload 形状与 KV key 布局沿用历史实现
// （JSON {count, updatedAt}、<prefix><ip>），逐字保留。

/**
 * 提取客户端 IP：CF-Connecting-IP 优先，回退 X-Real-IP，均缺失记 'unknown'。
 *
 * @param {Request} request 当前请求。
 * @returns {string}
 */
function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || 'unknown';
}

/**
 * 创建 IP 试错限速实例。
 *
 * @param {object} config
 * @param {string} config.prefix KV key 前缀（如 'login_fail:' / 'site-lock:throttle:'）。
 * @param {number} config.maxAttempts 锁定阈值：累计失败达到该次数即锁定。
 * @param {number} config.lockoutSeconds 锁定窗口时长（秒），每次失败刷新 TTL（持续失败则持续锁定）。
 * @returns {{get: Function, register: Function, clear: Function, maxAttempts: number}}
 */
export function createIpThrottle({ prefix, maxAttempts, lockoutSeconds }) {
  return {
    maxAttempts,

    /**
     * 读取当前客户端 IP 的失败计数状态。payload 缺失或损坏一律容错为 0。
     *
     * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
     * @param {Request} request 当前请求。
     * @returns {Promise<{ip: string, key: string, count: number, locked: boolean}>}
     */
    async get(env, request) {
      const ip = getClientIp(request);
      const key = `${prefix}${ip}`;
      const raw = await env.NAV_AUTH.get(key);
      let count = 0;
      if (raw) {
        try {
          count = Number(JSON.parse(raw).count) || 0;
        } catch {
          count = 0;
        }
      }
      return { ip, key, count, locked: count >= maxAttempts };
    },

    /**
     * 记录一次失败，并刷新锁定窗口 TTL。
     *
     * @param {object} env Cloudflare Workers 环境绑定。
     * @param {string} key get 返回的 KV key。
     * @param {number} [currentCount=0] 当前已知失败次数。
     * @returns {Promise<void>}
     */
    async register(env, key, currentCount = 0) {
      const count = (Number(currentCount) || 0) + 1;
      await env.NAV_AUTH.put(key, JSON.stringify({ count, updatedAt: Date.now() }), {
        expirationTtl: lockoutSeconds,
      });
    },

    /**
     * 验证成功后清除失败计数。空 key 容错跳过。
     *
     * @param {object} env Cloudflare Workers 环境绑定。
     * @param {string} key get 返回的 KV key。
     * @returns {Promise<void>}
     */
    async clear(env, key) {
      if (!key) return;
      await env.NAV_AUTH.delete(key);
    },
  };
}
