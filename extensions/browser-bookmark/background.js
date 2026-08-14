// 站内浏览缓存预热：浏览器启动/扩展安装时后台拉取第一页与分类，
// 写入与 popup 相同的本地缓存结构，首次打开 popup 浏览视图直接命中，
// 服务端冷启动延迟不再被用户感知。
const BROWSE_CACHE_KEY = 'browse:cache:v1';

// 与 popup.flattenCategoryTree 同构：分类树展平为 [{ name, level }]
function flattenCategoryTree(nodes, level = 0, out = []) {
  for (const node of nodes) {
    if (!node || !String(node.name || '').trim()) continue;
    out.push({ name: String(node.name).trim(), level });
    if (Array.isArray(node.children) && node.children.length) {
      flattenCategoryTree(node.children, level + 1, out);
    }
  }
  return out;
}

async function warmBrowseCache() {
  try {
    const settings = await chrome.storage.sync.get(['baseUrl', 'token', 'browseCacheMinutes']);
    const baseUrl = settings.baseUrl ? settings.baseUrl.replace(/\/$/, '') : '';
    const token = settings.token || '';
    if (!baseUrl || !token) return;

    const headers = { Authorization: `Bearer ${token}` };
    const [listRes, catsRes] = await Promise.all([
      fetch(`${baseUrl}/api/config?all=1`, { headers }),
      fetch(`${baseUrl}/api/categories/tree`, { headers }),
    ]);
    if (!listRes.ok || !catsRes.ok) return;

    const [listData, catsData] = await Promise.all([listRes.json(), catsRes.json()]);
    // 与 popup 的 loadFullCache 同构：data 为全量书签数组
    const data = listData && listData.data;
    const items = Array.isArray(data) ? data : [];
    const total = Number(listData.total != null ? listData.total : items.length) || items.length;
    // 分类树展平为 [{ name, level }]（与 popup 的 flattenCategoryTree 同构）
    const tree = Array.isArray(catsData && catsData.data) ? catsData.data : [];
    const categories = flattenCategoryTree(tree);
    const minutes = Number(settings.browseCacheMinutes);
    const ttlMinutes = Number.isFinite(minutes) && minutes >= 0 ? minutes : 5;

    // 写新格式全量缓存（kind==='full'）；旧格式缓存会被 popup 视为无效重建
    await chrome.storage.local.set({
      [BROWSE_CACHE_KEY]: { kind: 'full', fetchedAt: Date.now(), ttlMinutes, items, total, categories },
    });
  } catch {
    // 预热失败静默：popup 首次打开仍走正常拉取
  }
}

// 创建右键菜单（标题跟随站点设置名，未连接时用默认名）
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(['siteName'], ({ siteName }) => {
    chrome.contextMenus.create({
      id: "starnav-collect",
      title: `收藏当前网页到 ${siteName || 'StarNav'}`,
      contexts: ["page", "link"]
    });
  });
  warmBrowseCache();
});

// 站点名变化时更新右键菜单标题
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.siteName) {
    chrome.contextMenus.update("starnav-collect", {
      title: `收藏当前网页到 ${changes.siteName.newValue || 'StarNav'}`,
    }).catch(() => {});
  }
});

// 浏览器启动时预热（MV3 service worker 由事件唤醒）
chrome.runtime.onStartup.addListener(() => warmBrowseCache());

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "starnav-collect") return;

  const url = info.linkUrl || info.pageUrl || tab.url;
  const name = tab.title || "未命名网页";

  // 获取配置
  chrome.storage.sync.get(["apiUrl", "apiToken", "defaultCategory", "siteName"], async (settings) => {
    const apiUrl = settings.apiUrl ? settings.apiUrl.replace(/\/$/, "") : "";
    const apiToken = settings.apiToken || "";
    const defaultCategory = settings.defaultCategory || "未分类";
    const siteName = settings.siteName || 'StarNav';

    if (!apiUrl || !apiToken) {
      showNotification("error", "收藏失败", "请先在插件选项中配置 API 地址和 Token！");
      return;
    }

    try {
      // 1. 自动获取 Favicon
      let logo = "";
      try {
        const domain = new URL(url).origin;
        logo = `${apiUrl}/api/favicon?url=${encodeURIComponent(url)}`;
      } catch (e) {}

      // 2. 提交书签
      const response = await fetch(`${apiUrl}/api/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiToken}`
        },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          logo: logo,
          catelog: defaultCategory,
          desc: "通过浏览器插件一键收藏",
          visibility: "public"
        })
      });

      const result = await response.json();

      if (response.status === 201 || result.code === 201) {
        showNotification("success", "收藏成功", `已成功收藏到分类「${defaultCategory}」！`);
      } else if (result.code === 409) {
        showNotification("warning", "重复收藏", `该网页已在您的 ${siteName} 中收藏过啦！`);
      } else {
        showNotification("error", "收藏失败", result.message || "服务器返回错误");
      }
    } catch (err) {
      showNotification("error", "网络错误", `无法连接到您的 ${siteName} 实例，请检查网络或 API 地址。`);
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

// 图标自动补全：popup 站内浏览点击无图标书签时上报（fire-and-forget，
// popup 关闭后由本 background 接管），成功后本地 patch full cache 该条 logo。
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== 'ensure-favicon') return; // 非本消息不拦截
  ensureFaviconForSite(message.siteId)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, reason: 'unexpected' }));
  return true; // 异步 sendResponse
});

async function ensureFaviconForSite(siteId) {
  const settings = await chrome.storage.sync.get(['baseUrl', 'token']);
  const baseUrl = settings.baseUrl ? settings.baseUrl.replace(/\/$/, '') : '';
  const token = settings.token || '';
  if (!baseUrl || !token || siteId == null) return { ok: false, reason: 'not-configured' };

  // 缓存该条已有图标（可能刚被其他入口补过）→ 省一次请求
  const cached = await chrome.storage.local.get(BROWSE_CACHE_KEY);
  const cache = cached[BROWSE_CACHE_KEY];
  if (cache && cache.kind === 'full' && Array.isArray(cache.items)) {
    const item = cache.items.find((s) => Number(s.id) === Number(siteId));
    if (item && item.logo) return { ok: false, reason: 'has-logo' };
  }

  // 20s 超时：服务端 getFavicon 5 源串行（每源 5s 上限），10s 不够慢源场景；
  // 仍小于 Workers 请求 30s 限制。失败静默——下次点击再试
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  let result;
  let httpStatus = 0;
  try {
    const res = await fetch(`${baseUrl}/api/site/${encodeURIComponent(siteId)}/ensure-favicon`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    httpStatus = res.status;
    const data = await res.json().catch(() => ({}));
    result = data && data.data;
  } finally {
    clearTimeout(timer);
  }
  if (!result || !result.updated || !result.favicon) {
    const reason = result ? result.reason : `http-${httpStatus}`;
    // 调试可见化：popup 下次打开时显示失败原因（10 分钟内）
    await chrome.storage.local.set({
      'favicon:debug:last': { siteId: Number(siteId), at: Date.now(), ok: false, reason, httpStatus },
    }).catch(() => {});
    return { ok: false, reason };
  }

  // 本地 patch：只改该条 logo，零额外全量请求；下次打开 popup 直接见图标
  const fresh = await chrome.storage.local.get(BROWSE_CACHE_KEY);
  const freshCache = fresh[BROWSE_CACHE_KEY];
  if (freshCache && freshCache.kind === 'full' && Array.isArray(freshCache.items)) {
    const target = freshCache.items.find((s) => Number(s.id) === Number(siteId));
    if (target) {
      target.logo = result.favicon;
      await chrome.storage.local.set({ [BROWSE_CACHE_KEY]: freshCache }).catch(() => {});
    }
  }
  return { ok: true, favicon: result.favicon };
}