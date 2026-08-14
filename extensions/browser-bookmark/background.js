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
    const settings = await chrome.storage.sync.get(['baseUrl', 'token']);
    const baseUrl = settings.baseUrl ? settings.baseUrl.replace(/\/$/, '') : '';
    const token = settings.token || '';
    if (!baseUrl || !token) return;

    const headers = { Authorization: `Bearer ${token}` };
    const params = new URLSearchParams({ page: '1', pageSize: '30', keyword: '', catalog: '', sort: '' });
    const [listRes, catsRes] = await Promise.all([
      fetch(`${baseUrl}/api/config?${params.toString()}`, { headers }),
      fetch(`${baseUrl}/api/categories/tree`, { headers }),
    ]);
    if (!listRes.ok || !catsRes.ok) return;

    const [listData, catsData] = await Promise.all([listRes.json(), catsRes.json()]);
    // 解析规则与 popup.extractSiteList 保持一致：data 数组或 data.list 形态
    const data = listData && listData.data;
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.list) ? data.list : []);
    const total = Number(listData.total != null ? listData.total : (data && data.total)) || items.length;
    // 分类树展平为 [{ name, level }]（与 popup 的 flattenCategoryTree 同构）
    const tree = Array.isArray(catsData && catsData.data) ? catsData.data : [];
    const categories = flattenCategoryTree(tree);

    await chrome.storage.local.set({
      [BROWSE_CACHE_KEY]: { signature: '||', fetchedAt: Date.now(), items, total, page: 2, categories },
    });
  } catch {
    // 预热失败静默：popup 首次打开仍走正常拉取
  }
}

// 创建右键菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "starnav-collect",
    title: "收藏当前网页到 StarNav",
    contexts: ["page", "link"]
  });
  warmBrowseCache();
});

// 浏览器启动时预热（MV3 service worker 由事件唤醒）
chrome.runtime.onStartup.addListener(() => warmBrowseCache());

// 监听右键菜单点击
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "starnav-collect") return;

  const url = info.linkUrl || info.pageUrl || tab.url;
  const name = tab.title || "未命名网页";

  // 获取配置
  chrome.storage.sync.get(["apiUrl", "apiToken", "defaultCategory"], async (settings) => {
    const apiUrl = settings.apiUrl ? settings.apiUrl.replace(/\/$/, "") : "";
    const apiToken = settings.apiToken || "";
    const defaultCategory = settings.defaultCategory || "未分类";

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
        showNotification("warning", "重复收藏", "该网页已在您的 StarNav 中收藏过啦！");
      } else {
        showNotification("error", "收藏失败", result.message || "服务器返回错误");
      }
    } catch (err) {
      showNotification("error", "网络错误", "无法连接到您的 StarNav 实例，请检查网络或 API 地址。");
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