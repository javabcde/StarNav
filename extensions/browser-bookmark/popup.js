// popup 壳：元素注册表、共享配置/工具、三 Tab 状态机、视图装配与启动编排。
// 各视图逻辑在 browse-view.js / collect-view.js / sync-view.js（UMD 挂 globalThis），
// 壳只做装配：创建 ctx → view.mount() → switchTab 驱动 onEnter/onLeave。
const els = {
  name: document.getElementById('name'),
  url: document.getElementById('url'),
  desc: document.getElementById('desc'),
  appTitle: document.getElementById('appTitle'),
  appTitleText: document.getElementById('appTitleText'),
  openSiteBtn: document.getElementById('openSiteBtn'),
  syncHint: document.getElementById('syncHint'),
  catelog: document.getElementById('catelog'),
  tags: document.getElementById('tags'),
  visibility: document.getElementById('visibility'),
  logo: document.getElementById('logo'),
  categoryList: document.getElementById('categoryList'),
  tagList: document.getElementById('tagList'),
  saveBtn: document.getElementById('saveBtn'),
  forceSaveBtn: document.getElementById('forceSaveBtn'),
  fetchBtn: document.getElementById('fetchBtn'),
  fetchFaviconBtn: document.getElementById('fetchFaviconBtn'),
  suggestCategoryBtn: document.getElementById('suggestCategoryBtn'),
  suggestTagsBtn: document.getElementById('suggestTagsBtn'),
  checkDuplicateBtn: document.getElementById('checkDuplicateBtn'),
  optionsBtn: document.getElementById('optionsBtn'),
  syncBtn: document.getElementById('syncBtn'),
  syncResult: document.getElementById('syncResult'),
  status: document.getElementById('status'),
  duplicateBox: document.getElementById('duplicateBox'),
  tabBrowse: document.getElementById('tabBrowse'),
  tabCollect: document.getElementById('tabCollect'),
  tabSync: document.getElementById('tabSync'),
  browseView: document.getElementById('browse-view'),
  collectView: document.getElementById('collect-view'),
  syncView: document.getElementById('sync-view'),
  browseSearch: document.getElementById('browseSearch'),
  browseSort: document.getElementById('browseSort'),
  browseRefresh: document.getElementById('browseRefresh'),
  browseCats: document.getElementById('browseCats'),
  browseCatChildren: document.getElementById('browseCatChildren'),
  browseList: document.getElementById('browseList'),
  browseMore: document.getElementById('browseMore'),
  browseStatus: document.getElementById('browseStatus'),
};

let config = {};

function setStatus(message, type = 'info') {
  els.status.textContent = message;
  els.status.style.color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#64748b';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

async function restoreCachedExtensionIcon() {
  if (!chrome.action?.setIcon || !config.siteIcon) return false;
  try {
    // 尝试直接用 URL 设置，如果失败（例如，因为是远程 URL），则回退到 fetch+canvas
    await chrome.action.setIcon({ path: config.siteIcon });
    return true;
  } catch (e) {
    try {
      const response = await fetch(config.siteIcon);
      const blob = await response.blob();
      const imageBitmap = await createImageBitmap(blob);
      const sizes = [16, 32, 48, 128];
      const imageData = {};
      for (const size of sizes) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imageBitmap, 0, 0, size, size);
        imageData[size] = ctx.getImageData(0, 0, size, size);
      }
      await chrome.action.setIcon({ imageData });
      return true;
    } catch {
      return false;
    }
  }
}

async function apiFetch(path, options = {}) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) throw new Error(`请先在设置中填写 ${config.siteName || 'StarNav'} 地址`);
  if (!config.token) throw new Error('请先在设置中填写 Bearer Token');
  return Contract.apiFetch(path, { baseUrl, token: config.token, ...options });
}

function escapeHTML(v) { return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function renderDatalist(el, items, getValue) {
  el.innerHTML = '';
  for (const item of items || []) {
    const value = getValue(item);
    if (!value) continue;
    const option = document.createElement('option');
    option.value = value;
    el.appendChild(option);
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs[0] ? tabs[0] : null;
}

async function loadConfig() {
  const syncData = await chrome.storage.sync.get([
    'baseUrl',
    'token',
    'defaultCategory',
    'defaultTags',
    'siteIcon',
    'siteName',
    'browseCacheMinutes',
  ]);
  const localData = await chrome.storage.local.get([
    'categories',
    'tags',
  ]);

  config = { ...syncData, ...localData };
  applySiteName();

  renderDatalist(els.categoryList, config.categories || [], (item) => item.name || item.catelog || item);
  renderDatalist(els.tagList, config.tags || [], (item) => item.name || item.tag || item);
}

// 用站点设置里的名字替换写死的 StarNav（options 连接时已存 storage.sync.siteName）
// 注意：只改文本 span 的 textContent，避免覆盖 h1 内的主站跳转按钮
function applySiteName() {
  const siteName = config.siteName || 'StarNav';
  document.title = `收藏到 ${siteName}`;
  if (els.appTitleText) els.appTitleText.textContent = `收藏到 ${siteName}`;
  if (els.syncHint) els.syncHint.textContent = `把浏览器收藏夹里的书签同步到 ${siteName} 网站，以浏览器为基准；网站上的手动书签不会被覆盖。`;
}

// 图标补全调试可见化：上次点击补全失败（10 分钟内）时显示原因。
// 必须在 setStatus('插件已就绪。') 之后执行，否则会被其覆盖（reviewer F1）。
// 403=整站锁/token 问题、404=书签不存在、timeout=服务端抓取超时
function showIconDebug() {
  try {
    chrome.storage.local.get(Contract.STORAGE_KEYS.FAVICON_DEBUG_LAST).then((data) => {
      const debug = data[Contract.STORAGE_KEYS.FAVICON_DEBUG_LAST];
      if (debug && debug.at && Date.now() - debug.at < Contract.ICON_DEBUG_TTL_MS) {
        const reason = debug.httpStatus ? `${debug.reason} (HTTP ${debug.httpStatus})` : debug.reason;
        setStatus(`上次图标补全未生效：${reason}`, 'warning');
        chrome.storage.local.remove(Contract.STORAGE_KEYS.FAVICON_DEBUG_LAST).catch(() => {});
      }
    }).catch(() => {
      // 忽略读取失败
    });
  } catch {
    // 忽略读取失败
  }
}

// ===== 视图装配 =====
const ctx = {
  els,
  Contract,
  BrowseLogic,
  config: () => config,
  setStatus,
  apiFetch,
  escapeHTML,
  getActiveTab,
  // 收藏/同步成功后的浏览缓存刷新钩子（指向浏览视图内部实现，惰性求值）
  onCacheMutated: () => browseView.refreshAfterCacheMutation(),
  document,
  localStorage,
};

const collectView = StarNavCollectView.create(ctx);
const syncView = StarNavSyncView.create(ctx);
const browseView = StarNavBrowseView.create(ctx);

// ===== 三 Tab 切换 =====
const TAB_CONFIG = [
  { btn: els.tabBrowse, view: els.browseView },
  { btn: els.tabCollect, view: els.collectView },
  { btn: els.tabSync, view: els.syncView },
];

function switchTab(activeBtn) {
  for (const { btn, view } of TAB_CONFIG) {
    const isActive = btn === activeBtn;
    btn.classList.toggle('active', isActive);
    view.hidden = !isActive;
  }
  if (activeBtn === els.tabCollect) {
    collectView.onEnter();
  } else {
    collectView.onLeave();
  }
}

els.tabBrowse.addEventListener('click', () => switchTab(els.tabBrowse));
els.tabCollect.addEventListener('click', () => switchTab(els.tabCollect));
els.tabSync.addEventListener('click', () => switchTab(els.tabSync));

els.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
els.openSiteBtn.addEventListener('click', async () => {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  if (!baseUrl) {
    setStatus('请先在设置中填写主站地址', 'error');
    return;
  }
  try {
    await chrome.tabs.create({ url: baseUrl, active: true });
  } catch (error) {
    setStatus(`打开主站失败：${error.message || error}`, 'error');
    return;
  }
  window.close();
});

async function initPopup() {
  await loadConfig();
  restoreCachedExtensionIcon().catch(() => {});

  // 三个视图各自挂载（绑定监听 + 恢复/预填/加载，幂等）
  browseView.mount();
  collectView.mount();
  syncView.mount();

  if (!config.baseUrl || !config.token) {
    setStatus(`请先打开设置，填写 ${config.siteName || 'StarNav'} 地址和 Token。`, 'error');
    return;
  }

  setStatus('插件已就绪。');
  showIconDebug();
  // 查重只在进入收藏视图时执行（见 switchTab），打开 popup 默认停在浏览视图，不打扰
}

initPopup();
