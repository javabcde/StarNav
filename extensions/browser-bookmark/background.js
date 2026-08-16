// 站内浏览缓存预热：浏览器启动/扩展安装时后台拉取第一页与分类，
// 写入与 popup 相同的本地缓存结构，首次打开 popup 浏览视图直接命中，
// 服务端冷启动延迟不再被用户感知。
// 契约模块（extension-contract.js）与浏览逻辑（popup-logic.js）先行加载：
// 缓存键/形状常量、消息类型、HTTP 客户端、收藏载荷来自 Contract；
// 形状守卫/全量缓存构建（fetchFullBrowseCache）来自 BrowseLogic（与 popup 共用，不再本地拷贝）。
importScripts('extension-contract.js', 'popup-logic.js');

async function warmBrowseCache() {
  try {
    const settings = await chrome.storage.sync.get(Contract.CONFIG_KEYS.sync);
    const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
    const token = settings.token || '';
    if (!baseUrl || !token) return;

    // 全量缓存构建统一走 BrowseLogic.fetchFullBrowseCache（与 popup 的 loadFullCache 同构）
    const cache = await BrowseLogic.fetchFullBrowseCache(
      (path) => Contract.apiFetch(path, { baseUrl, token }),
      { minutes: settings.browseCacheMinutes },
    );

    // 写新格式全量缓存（kind==='full'）；旧格式缓存会被 popup 视为无效重建
    await chrome.storage.local.set({
      [Contract.BROWSE_CACHE_KEY]: cache,
    });
  } catch {
    // 预热失败静默：popup 首次打开仍走正常拉取
  }
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
});

// 站点名变化时更新右键菜单标题
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.siteName) {
    chrome.contextMenus.update("starnav-collect", {
      title: Contract.collectMenuTitle(changes.siteName.newValue),
    }).catch(() => {});
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
});

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "starnav-collect") return;

  const url = info.linkUrl || info.pageUrl || tab.url;
  const name = tab.title || "未命名网页";

  // 获取配置（baseUrl/token——与 options.js/popup.js 同一套键，清单见契约模块）
  chrome.storage.sync.get(Contract.CONFIG_KEYS.sync, async (settings) => {
    const baseUrl = Contract.normalizeBaseUrl(settings.baseUrl);
    const token = settings.token || "";
    const defaultCategory = settings.defaultCategory || "未分类";
    const siteName = settings.siteName || 'StarNav';

    if (!baseUrl || !token) {
      showNotification("error", "收藏失败", "请先在插件选项中配置 API 地址和 Token！");
      return;
    }

    try {
      // 1. 自动获取 Favicon
      let logo = "";
      try {
        const domain = new URL(url).origin;
        logo = `${baseUrl}/api/favicon?url=${encodeURIComponent(url)}`;
      } catch (e) {}

      // 2. 提交书签（统一 /api/sites + 契约载荷构建；409 重复走警告通知）
      const payload = Contract.buildCollectPayload({
        name,
        url,
        logo,
        catelog: defaultCategory,
        desc: "通过浏览器插件一键收藏",
        visibility: "public",
      });
      await Contract.apiFetch('/api/sites', {
        baseUrl,
        token,
        method: 'POST',
        body: JSON.stringify(payload),
      });

      showNotification("success", "收藏成功", `已成功收藏到分类「${defaultCategory}」！`);
    } catch (err) {
      if (err.status === 409 || (err.data && err.data.code === 409)) {
        showNotification("warning", "重复收藏", `该网页已在您的 ${siteName} 中收藏过啦！`);
      } else if (err.status) {
        showNotification("error", "收藏失败", err.message || "服务器返回错误");
      } else {
        showNotification("error", "网络错误", `无法连接到您的 ${siteName} 实例，请检查网络或 API 地址。`);
      }
    }
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
  if (message.type !== Contract.MESSAGE_TYPES.ENSURE_FAVICON) return; // 非本消息不拦截
  ensureFaviconForSite(message.siteId)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: 'unexpected' }));
  return true; // 异步 sendResponse
});

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