// 插件跨文件契约（extension contract）：全量缓存键/形状常量、消息类型、存储键、
// 配置键清单、HTTP 客户端（apiFetch）、收藏载荷构建（buildCollectPayload）。
// 不碰 DOM / chrome API，可被 node:test 直接测试（tests/extension-contract.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.Contract，node 下走 module.exports。
// 形状守卫（isFullBrowseCache）与分类树展平（flattenCategoryTree）属浏览决策逻辑，
// 留在 popup-logic.js（background 经 importScripts 同时加载两个文件）。
(function (global) {
  'use strict';

  // ── 全量缓存契约（browse:cache:v1）───────────────────────────────
  const BROWSE_CACHE_KEY = 'browse:cache:v1';
  const BROWSE_CACHE_DEFAULT_MINUTES = 5;
  // 全量缓存形状：{ kind: 'full', fetchedAt, ttlMinutes, items, total, categories }
  const BROWSE_CACHE_FIELDS = ['kind', 'fetchedAt', 'ttlMinutes', 'items', 'total', 'categories'];

  // ── 消息类型（popup ↔ background 消息契约）───────────────────────
  const MESSAGE_TYPES = {
    ENSURE_FAVICON: 'ensure-favicon',
    SYNC_SITE_NAME: 'sync-site-name',
    // 收藏小窗保存结果上报：小窗关闭后由 background 统一系统通知
    COLLECT_RESULT: 'collect-result',
  };

  // ── 存储键契约 ───────────────────────────────────────────────────
  const STORAGE_KEYS = {
    BROWSE_CACHE: BROWSE_CACHE_KEY,
    BROWSE_VIEW: 'browse:view:v1',
    FAVICON_DEBUG_LAST: 'favicon:debug:last',
    // 右键收藏小窗：待收藏候选（background 写入 → 小窗读取）与上次选择分类记忆
    LAST_COLLECT_CANDIDATE: 'lastCollectCandidate',
    LAST_COLLECT_CATEGORY: 'lastCollectCategory',
    // 右键坐标（content script 记录 → background 开窗定位）：小窗跟随鼠标右键位置
    CONTEXT_MENU_POSITION: 'lastContextMenuPosition',
  };

  // ── 配置键清单（options.js 写入、popup/background 读取）──────────
  const CONFIG_KEYS = {
    sync: ['baseUrl', 'token', 'defaultCategory', 'defaultTags', 'siteName', 'siteIcon', 'browseCacheMinutes'],
    local: ['categories', 'tags', 'metadataUpdatedAt'],
  };

  // ── 图标自动补全契约（Icon Auto-Fill，术语见 CONTEXT.md）────────
  // 客户端超时需大于服务端最坏抓取预算（getFavicon 5 源串行 × 每源 5s ≈ 25s）
  // 且小于 Workers 请求 30s 上限；失败原因枚举与服务端 ensure-favicon 的 reason 对齐。
  const ICON_TIMEOUT_MS = 28000;
  const ICON_FAILURE_REASONS = {
    HAS_LOGO: 'has-logo',
    ALREADY_FAILED: 'already-failed',
    NO_FAVICON: 'no-favicon',
    ERROR: 'error',
    NO_SITE: 'no-site',
    FILLED: 'filled',
  };
  // 调试可见化窗口：popup 显示 background 记录的最近一次补全失败原因的有效期
  const ICON_DEBUG_TTL_MS = 10 * 60 * 1000;

  function normalizeBaseUrl(value) {
    return String(value || '').trim().replace(/\/+$/g, '');
  }

  function escapeHTML(v) {
    return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 统一 API 客户端：拼 URL、鉴权头、可选超时、非 JSON 兜底。
   * !ok 时抛错并附带 error.status / error.data（错误文案：data.message || data.error || HTTP 状态）。
   * 默认无超时；传 timeoutMs 时超时抛错保留 name='AbortError'（调用方可区分超时与网络错误），
   * message 为「连接超时（N 秒），请检查网络或服务端状态」。
   *
   * @param {string} path 以 / 开头的接口路径
   * @param {{ baseUrl?: string, token?: string, timeoutMs?: number, method?: string, body?: string, headers?: object, signal?: AbortSignal }} options
   */
  async function apiFetch(path, { baseUrl, token = '', timeoutMs = 0, ...fetchOptions } = {}) {
    const normalized = normalizeBaseUrl(baseUrl);
    if (!normalized) throw new Error('请先填写 StarNav 地址');
    const controller = timeoutMs > 0 ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`${normalized}${path}`, {
        ...fetchOptions,
        signal: controller ? controller.signal : fetchOptions.signal,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(fetchOptions.body ? { 'Content-Type': 'application/json' } : {}),
          ...(fetchOptions.headers || {}),
        },
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { raw: text };
      }
      if (!res.ok) {
        const error = new Error(data?.message || data?.error || `请求失败：HTTP ${res.status}`);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    } catch (error) {
      if (controller && error && error.name === 'AbortError') {
        const timeoutError = new Error(`连接超时（${timeoutMs / 1000} 秒），请检查网络或服务端状态`);
        timeoutError.name = 'AbortError';
        throw timeoutError;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 收藏载荷构建：popup 表单保存与 background 右键收藏共用同一载荷形状。
   * 默认值对齐 popup getPayload：catelog 空回退「未分类」、visibility 默认 public。
   */
  function buildCollectPayload({ name = '', url = '', catelog = '', desc = '', visibility = 'public', logo = '', tags = '' } = {}) {
    return {
      name: String(name || '').trim(),
      url: String(url || '').trim(),
      desc: String(desc || '').trim(),
      catelog: String(catelog || '').trim() || '未分类',
      tags: Array.isArray(tags) ? tags : String(tags || '').trim(),
      visibility: visibility || 'public',
      logo: String(logo || '').trim(),
    };
  }
  /**
   * 右键菜单标题单一源：background.js 四处（onInstalled / onChanged / onStartup /
   * 消息同步）此前各自拼 `收藏当前网页到 ${siteName || 'StarNav'}`，默认值漂移风险。
   */
  function collectMenuTitle(siteName = '') {
    return `收藏当前网页到 ${siteName || 'StarNav'}`;
  }


  const Contract = {
    BROWSE_CACHE_KEY,
    BROWSE_CACHE_DEFAULT_MINUTES,
    BROWSE_CACHE_FIELDS,
    MESSAGE_TYPES,
    STORAGE_KEYS,
    CONFIG_KEYS,
    ICON_TIMEOUT_MS,
    ICON_FAILURE_REASONS,
    ICON_DEBUG_TTL_MS,
    normalizeBaseUrl,
    escapeHTML,
    apiFetch,
    buildCollectPayload,
    collectMenuTitle,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Contract;
  } else {
    global.Contract = Contract;
  }
})(typeof self !== 'undefined' ? self : globalThis);
