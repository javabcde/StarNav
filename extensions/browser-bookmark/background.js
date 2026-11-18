// 站内浏览缓存：浏览器启动/扩展安装时后台拉取全量书签与分类，
// 写入与 popup 相同的本地缓存结构，首次打开 popup 浏览视图直接命中；
// 地址栏搜索（omnibox）无缓存时复用同一拉取链路。
// 契约模块（extension-contract.js）、浏览逻辑（popup-logic.js）、
// 地址栏搜索逻辑（omnibox-logic.js）先行加载：
// 缓存键/形状常量、消息类型、HTTP 客户端、收藏载荷来自 Contract；
// 形状守卫/全量缓存构建（fetchFullBrowseCache）来自 BrowseLogic（与 popup 共用）；
// 匹配排序/建议描述/回车目标判定来自 OmniboxLogic。
importScripts('extension-contract.js', 'popup-logic.js', 'omnibox-logic.js');

// 内存快照：地址栏建议必须在 onInputChanged 的同步回调里交付，
// 等 await（storage 读取/网络拉取）之后再 suggest 会依赖浏览器是否接受延迟建议；
// 快照在读取/刷新/缓存变更三处维护，有快照时建议零等待、同步返回。
let browseCacheSnapshot = null;

// 读取已落盘的全量缓存；旧格式/缺失返回 null
async function readBrowseCache() {
  const stored = await chrome.storage.local.get(Contract.BROWSE_CACHE_KEY);
  const cache = stored[Contract.BROWSE_CACHE_KEY];
  if (!BrowseLogic.isFullBrowseCache(cache)) return null;
  browseCacheSnapshot = cache;
  return cache;
}

// 拉取并写入全量缓存（未配置 baseUrl/token 返回 null）
async function refreshBrowseCache() {
  const settings = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
  const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
  const token = settings.token || '';
  if (!baseUrl || !token) return null;

  // 全量缓存构建统一走 BrowseLogic.fetchFullBrowseCache（与 popup 的 loadFullCache 同构）
  const cache = await BrowseLogic.fetchFullBrowseCache(
    (path) => Contract.apiFetch(path, { baseUrl, token }),
    { minutes: settings.browseCacheMinutes },
  );

  // 写新格式全量缓存（kind==='full'）；旧格式缓存会被 popup 视为无效重建
  await chrome.storage.local.set({
    [Contract.BROWSE_CACHE_KEY]: cache,
  });
  browseCacheSnapshot = cache;
  return cache;
}

// 并发去重：预热/地址栏输入同时触发时只发一次请求；失败返回 null 不抛出
let browseCacheRefresh = null;
function refreshBrowseCacheOnce() {
  if (!browseCacheRefresh) {
    browseCacheRefresh = refreshBrowseCache()
      .catch(() => null)
      .finally(() => { browseCacheRefresh = null; });
  }
  return browseCacheRefresh;
}

async function warmBrowseCache() {
  // 预热失败静默：popup 首次打开仍走正常拉取
  await refreshBrowseCacheOnce();
}

// ── 地址栏搜索（omnibox）─────────────────────────────────────────
// manifest 注册关键字 q：地址栏输入 `q` + 空格进入 StarNav 收藏搜索。
// 建议来自本地全量缓存（与 popup 站内浏览同一份数据，零额外请求）；
// 缓存缺失时等待一次拉取（上限 1.5s），过期时先用旧数据并在后台刷新。
const OMNIBOX_CACHE_WAIT_MS = 1500;
const OMNIBOX_REFRESH_MIN_INTERVAL_MS = 15 * 1000;
let lastBrowseCacheRefreshAt = 0;

function refreshBrowseCacheIfNeeded(cache) {
  if (BrowseLogic.isBrowseCacheFresh(cache, cache && cache.ttlMinutes)) return;
  if (Date.now() - lastBrowseCacheRefreshAt < OMNIBOX_REFRESH_MIN_INTERVAL_MS) return;
  lastBrowseCacheRefreshAt = Date.now();
  refreshBrowseCacheOnce();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 进入关键字输入时预取：用户敲完关键词前缓存已就绪
chrome.omnibox.onInputStarted.addListener(() => {
  readBrowseCache()
    .then((cache) => refreshBrowseCacheIfNeeded(cache))
    .catch(() => {});
});

// 构造本次输入的建议（含默认行）。同步函数：不碰 storage，只用内存快照。
function buildOmniboxResponse(query, cache, configured, loading) {
  const items = cache ? cache.items : [];
  const matches = query
    ? OmniboxLogic.searchOmniboxItems(items, query, OmniboxLogic.MAX_SUGGESTIONS)
    : [];
  try {
    chrome.omnibox.setDefaultSuggestion({
      description: OmniboxLogic.renderDefaultSuggestion({
        query,
        configured,
        total: cache ? (Number(cache.total) || items.length) : 0,
        matched: matches.length,
        loading,
      }),
    });
  } catch (error) {
    // 默认行失败不应拖累候选列表
    console.warn('omnibox 默认建议设置失败', error);
  }
  return OmniboxLogic.buildOmniboxSuggestions(matches, query);
}

// 冷启动无快照：先同步给默认行 + 空建议（本次输入立即可见），
// 再异步等一次全量拉取；下一次输入即可走同步快照。
async function hydrateOmniboxSuggestions(text, suggest) {
  const query = String(text || '').trim();
  try {
    const settings = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
    const configured = Boolean(Contract.normalizeBaseUrl(settings.baseUrl) && settings.token);
    let cache = await readBrowseCache();
    if (configured && !cache) {
      const fetched = await Promise.race([refreshBrowseCacheOnce(), delay(OMNIBOX_CACHE_WAIT_MS)]);
      cache = BrowseLogic.isFullBrowseCache(fetched) ? fetched : null;
    }
    suggest(buildOmniboxResponse(query, cache, configured, false));
  } catch (error) {
    console.warn('omnibox 建议加载失败', error);
  }
}

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  const query = String(text || '').trim();
  if (browseCacheSnapshot) {
    // 同步交付：建议与默认行在同一回调内完成，不依赖延迟交付是否被浏览器接受
    suggest(buildOmniboxResponse(query, browseCacheSnapshot, true, false));
    refreshBrowseCacheIfNeeded(browseCacheSnapshot);
    return;
  }
  chrome.omnibox.setDefaultSuggestion({
    description: OmniboxLogic.renderDefaultSuggestion({
      query,
      configured: true,
      total: 0,
      matched: 0,
      loading: true,
    }),
  });
  suggest([]);
  hydrateOmniboxSuggestions(text, suggest);
});

chrome.omnibox.onInputEntered.addListener(async (text, disposition) => {
  const raw = String(text || '').trim();
  const target = OmniboxLogic.normalizeOmniboxTarget(raw);
  let url = target.kind === 'url' ? target.url : '';

  // 未选中候选直接回车：按关键词取本地最佳匹配；无缓存时先等一次拉取（上限同建议路径）
  if (!url && raw) {
    let cache = await readBrowseCache();
    if (!cache) {
      const fetched = await Promise.race([refreshBrowseCacheOnce(), delay(OMNIBOX_CACHE_WAIT_MS)]);
      cache = BrowseLogic.isFullBrowseCache(fetched) ? fetched : null;
    }
    const [best] = cache ? OmniboxLogic.searchOmniboxItems(cache.items, raw, 1) : [];
    if (best) url = best.url;
  }

  if (!url) {
    const settings = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
    const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
    if (!baseUrl) {
      // 未配置且无本地匹配：直接把用户带到选项页
      chrome.runtime.openOptionsPage();
      return;
    }
    url = baseUrl;
  }
  navigateOmniboxUrl(url, disposition);
});

function navigateOmniboxUrl(url, disposition) {
  if (!OmniboxLogic.isSafeNavUrl(url)) return;
  if (disposition === 'newForegroundTab') {
    chrome.tabs.create({ url, active: true });
  } else if (disposition === 'newBackgroundTab') {
    chrome.tabs.create({ url, active: false });
  } else {
    chrome.tabs.update({ url });
  }
}

// ── 旧版书签镜像清理 ──────────────────────────────────────────────
// ≤1.2.x 曾把非私人收藏镜像到浏览器「其他书签/StarNav 收藏」，用 Chrome 原生书签联想
// 换取零前缀地址栏搜索。该策略已移除（StarNav 收藏不写入浏览器书签）：
// 升级时按旧版本记录的文件夹 id 一次性删除残留镜像，之后不再创建、不再对齐。
const LEGACY_MIRROR_FOLDER_KEY = 'bookmark:mirror:folderId';

async function purgeLegacyBookmarkMirror() {
  const stored = await chrome.storage.local.get(LEGACY_MIRROR_FOLDER_KEY);
  const folderId = stored[LEGACY_MIRROR_FOLDER_KEY];
  if (!folderId) return;
  try {
    await chrome.bookmarks.removeTree(folderId);
  } catch { /* 用户已手动删除该文件夹 */ }
  await chrome.storage.local.remove(LEGACY_MIRROR_FOLDER_KEY);
}

// 创建右键菜单（标题跟随站点设置名，未连接时用默认名）。
// 先 update 再 create：扩展重载/更新会再次触发 onInstalled，此时菜单已存在，
// 同 id 重复 create 抛 'duplicate id' 且安装时的旧标题（StarNav）残留；
// update 失败（菜单确实不存在）才 create。
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(Contract.CONFIG_KEYS.sync, ({ siteName }) => {
    const title = Contract.collectMenuTitle(siteName);
    chrome.contextMenus.update("starnav-collect", { title }).catch(() => {
      chrome.contextMenus.create({
        id: "starnav-collect",
        title,
        contexts: ["page", "link"],
      });
    });
  });
  warmBrowseCache();
  purgeLegacyBookmarkMirror();
});

// 站点名变化时更新右键菜单标题；全量缓存变化时同步内存快照（popup 刷新/收藏后重拉）
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.siteName) {
    chrome.contextMenus.update("starnav-collect", {
      title: Contract.collectMenuTitle(changes.siteName.newValue),
    }).catch(() => {});
  }
  if (area === 'local' && changes[Contract.BROWSE_CACHE_KEY]) {
    const next = changes[Contract.BROWSE_CACHE_KEY].newValue;
    browseCacheSnapshot = BrowseLogic.isFullBrowseCache(next) ? next : null;
  }
});

// 浏览器启动时预热（MV3 service worker 由事件唤醒）
chrome.runtime.onStartup.addListener(() => {
  warmBrowseCache();
  // 菜单标题兜底刷新：安装时站点名可能未配置（菜单为 StarNav），
  // 之后配置了名字但 storage 值未变时 onChanged 不触发——启动时强制对齐
  chrome.storage.sync.get(Contract.CONFIG_KEYS.sync, ({ siteName }) => {
    chrome.contextMenus.update("starnav-collect", {
      title: Contract.collectMenuTitle(siteName),
    }).catch(() => {});
  });
  purgeLegacyBookmarkMirror();
});

// 监听右键菜单点击：弹分类选择小窗（不再直存——收藏目标由用户在小窗内选定，
// 见 collect-picker-dialog 变更；选择与保存逻辑在 collect-picker.js）
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "starnav-collect") return;

  const url = info.linkUrl || info.pageUrl || tab.url;
  const name = tab.title || "未命名网页";

  // 获取配置（baseUrl/token——与 options.js/popup.js 同一套键，清单见契约模块）
  chrome.storage.sync.get(Contract.CONFIG_KEYS.sync, async (settings) => {
    const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
    const token = settings.token || "";

    if (!baseUrl || !token) {
      showNotification("error", "收藏失败", "请先在插件选项中配置 API 地址和 Token！");
      return;
    }

    // 候选数据暂存 storage.local（URL 可能超长且含特殊字符，不走 query 参数），
    // 随后弹小窗选分类；保存成功后由小窗清除
    await chrome.storage.local.set({
      [Contract.STORAGE_KEYS.LAST_COLLECT_CANDIDATE]: { url, name, ts: Date.now() },
    });
    // 小窗跟随鼠标右键位置：坐标由 content script 在 contextmenu 事件记录；
    // 未注入页面（chrome:// 等）无记录 → 不传 left/top，Chrome 居中
    const pos = await chrome.storage.local.get(Contract.STORAGE_KEYS.CONTEXT_MENU_POSITION);
    const p = pos[Contract.STORAGE_KEYS.CONTEXT_MENU_POSITION];
    const windowOptions = {
      url: 'collect-picker.html',
      type: 'popup',
      width: 340,
      height: 480,
      focused: true,
    };
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      windowOptions.left = Math.round(p.x);
      windowOptions.top = Math.round(p.y);
    } else {
      // 无坐标记录（右键的页面未注入 content script，如重载前已打开的标签页）：
      // 显式居中于当前焦点窗口，避免 Chrome 默认贴左上角
      try {
        const lastFocused = await chrome.windows.getLastFocused();
        if (lastFocused && Number.isFinite(lastFocused.width) && Number.isFinite(lastFocused.height)) {
          windowOptions.left = Math.round(lastFocused.left + (lastFocused.width - 340) / 2);
          windowOptions.top = Math.round(lastFocused.top + (lastFocused.height - 480) / 2);
        }
      } catch { /* 兜底失败则交给 Chrome 默认定位 */ }
    }
    await chrome.windows.create(windowOptions);
  });
});

// 弹出系统通知
function showNotification(type, title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icons/starnav.ico",
    title: title,
    message: message,
    priority: 2
  });
}

// 图标自动补全 / 站点名同步：popup 站内浏览点击无图标书签时上报（fire-and-forget，
// popup 关闭后由本 background 接管），成功后本地 patch full cache 该条 logo。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return;
  // 站点名同步：popup 拉取公开设置后直连更新菜单（不依赖 storage.onChanged——
  // 值未变时 onChanged 不触发，菜单会停留在安装时的默认名）
  if (message.type === Contract.MESSAGE_TYPES.SYNC_SITE_NAME) {
    chrome.contextMenus.update("starnav-collect", {
      title: Contract.collectMenuTitle(message.siteName),
    }).catch(() => {});
    return;
  }
  // 收藏小窗保存结果：小窗已关闭，统一由 background 通知用户结果
  if (message.type === Contract.MESSAGE_TYPES.COLLECT_RESULT) {
    notifyCollectResult(message);
    return;
  }
  if (message.type !== Contract.MESSAGE_TYPES.ENSURE_FAVICON) return; // 非本消息不拦截
  ensureFaviconForSite(message.siteId)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: 'unexpected' }));
  return true; // 异步 sendResponse
});

// 收藏小窗结果通知：ok=成功（含分类名）；kind=duplicate 重复；kind=server 服务端错误；
// kind=network 网络错误（站点名取配置，文案对齐原右键直存路径）
function notifyCollectResult({ ok, kind, message, category } = {}) {
  chrome.storage.sync.get(Contract.CONFIG_KEYS.sync, ({ siteName }) => {
    const name = siteName || 'StarNav';
    if (ok) {
      showNotification('success', '收藏成功', message || `已成功收藏到分类「${category || '未分类'}」！`);
    } else if (kind === 'duplicate') {
      showNotification('warning', '重复收藏', message || `该网页已在您的 ${name} 中收藏过啦！`);
    } else if (kind === 'server') {
      showNotification('error', '收藏失败', message || '服务器返回错误');
    } else {
      showNotification('error', '网络错误', message || `无法连接到您的 ${name} 实例，请检查网络或 API 地址。`);
    }
  });
}

async function ensureFaviconForSite(siteId) {
  const settings = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
  const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
  const token = settings.token || '';
  if (!baseUrl || !token || siteId == null) return { ok: false, reason: 'not-configured' };

  // 缓存该条已有图标（可能刚被其他入口补过）→ 省一次请求
  const cached = await chrome.storage.local.get(Contract.BROWSE_CACHE_KEY);
  const cache = cached[Contract.BROWSE_CACHE_KEY];
  if (BrowseLogic.isFullBrowseCache(cache)) {
    const item = cache.items.find((s) => Number(s.id) === Number(siteId));
    if (item && item.logo) return { ok: false, reason: Contract.ICON_FAILURE_REASONS.HAS_LOGO };
  }

  // 超时预算来自契约（ICON_TIMEOUT_MS）：服务端 5 源串行 × 每源 5s 的最坏耗时
  // 与 Workers 30s 上限都在契约注释里维护，客户端不再自算/自写魔数
  let result;
  let httpStatus = 0;
  let timedOut = false;
  try {
    const data = await Contract.apiFetch(`/api/site/${encodeURIComponent(siteId)}/ensure-favicon`, {
      baseUrl,
      token,
      timeoutMs: Contract.ICON_TIMEOUT_MS,
      method: 'POST',
    });
    result = data && data.data;
  } catch (error) {
    // 超时/网络层异常：不写失败标记（下次点击再试），但记录调试原因
    timedOut = error && error.name === 'AbortError';
    httpStatus = error && error.status || 0;
  }
  // 只要拿到 favicon URL 就本地 patch（has-logo 返回现有 URL 也算）：
  // 主站刚补过的书签，插件缓存借此立即对齐，不误报失败
  if (!result || !result.favicon) {
    const reason = result ? result.reason : (timedOut ? 'timeout' : `http-${httpStatus || 'network'}`);
    // 调试可见化：popup 下次打开时显示失败原因（10 分钟内）
    await chrome.storage.local.set({
      [Contract.STORAGE_KEYS.FAVICON_DEBUG_LAST]: { siteId: Number(siteId), at: Date.now(), ok: false, reason, httpStatus },
    }).catch(() => {});
    return { ok: false, reason };
  }

  // 本地 patch：只改该条 logo，零额外全量请求；下次打开 popup 直接见图标
  const fresh = await chrome.storage.local.get(Contract.BROWSE_CACHE_KEY);
  const freshCache = fresh[Contract.BROWSE_CACHE_KEY];
  if (BrowseLogic.isFullBrowseCache(freshCache)) {
    const target = freshCache.items.find((s) => Number(s.id) === Number(siteId));
    if (target) {
      target.logo = result.favicon;
      await chrome.storage.local.set({ [Contract.BROWSE_CACHE_KEY]: freshCache }).catch(() => {});
    }
  }
  return { ok: true, favicon: result.favicon };
}