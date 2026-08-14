const els = {
  name: document.getElementById('name'),
  url: document.getElementById('url'),
  desc: document.getElementById('desc'),
  appTitle: document.getElementById('appTitle'),
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
let lastDuplicate = null;

function setStatus(message, type = 'info') {
  els.status.textContent = message;
  els.status.style.color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : type === 'warning' ? '#d97706' : '#64748b';
}

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/g, '');
}

function authHeaders() {
  return config.token ? { Authorization: `Bearer ${config.token}` } : {};
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

  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
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
}

function escapeHTML(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}

// 浏览器书签根文件夹（不进入 folderPath）
const ROOT_FOLDER_NAMES = new Set([
  '书签栏', '其他书签', '移动设备书签',
  'Bookmarks Bar', 'Other Bookmarks', 'Mobile Bookmarks',
]);

// 递归展平 chrome.bookmarks.getTree() 结果：
// 跳过文件夹节点（无 url）；根文件夹（getTree 根节点之下第一层）不拼入 folderPath，
// 其顶层书签 folderPath 为空；自定义文件夹嵌套拼接为「父/子」。
function flattenBookmarks(nodes, parentPath = '', depth = 0) {
  const items = [];
  for (const node of nodes || []) {
    if (node.url) {
      items.push({
        id: node.id,
        title: node.title || '',
        url: node.url,
        folderPath: parentPath,
      });
      continue;
    }
    const isRootFolder = depth === 1 && ROOT_FOLDER_NAMES.has(node.title);
    const childPath = isRootFolder ? '' : parentPath ? `${parentPath}/${node.title}` : node.title;
    if (node.children && node.children.length) {
      items.push(...flattenBookmarks(node.children, childPath, depth + 1));
    }
  }
  return items;
}

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

function getPayload() {
  return {
    name: els.name.value.trim(),
    url: els.url.value.trim(),
    desc: els.desc.value.trim(),
    catelog: els.catelog.value.trim() || '未分类',
    tags: els.tags.value.trim(),
    visibility: els.visibility.value || 'public',
    logo: els.logo.value.trim(),
  };
}

function showDuplicate(duplicate) {
  lastDuplicate = duplicate || null;
  if (!duplicate) {
    els.duplicateBox.style.display = 'none';
    els.duplicateBox.textContent = '';
    els.forceSaveBtn.style.display = 'none';
    return;
  }

  const name = duplicate.name || duplicate.title || '已有书签';
  const url = duplicate.url || '';
  els.duplicateBox.style.display = 'block';
  els.duplicateBox.textContent = `检测到可能重复：${name}\n${url}`;
  els.forceSaveBtn.style.display = 'block';
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
function applySiteName() {
  const siteName = config.siteName || 'StarNav';
  document.title = `收藏到 ${siteName}`;
  if (els.appTitle) els.appTitle.textContent = `收藏到 ${siteName}`;
  if (els.syncHint) els.syncHint.textContent = `把浏览器收藏夹里的书签同步到 ${siteName} 网站，以浏览器为基准；网站上的手动书签不会被覆盖。`;
}

async function initPopup() {
  await loadConfig();
  restoreCachedExtensionIcon().catch(() => {});

  // 站内浏览：缓存命中直接显示本地数据，未命中/过期才拉取（错误在浏览视图内展示）
  loadBrowseView().catch(() => {});

  const tab = await getActiveTab();
  if (tab) {
    els.name.value = tab.title || '';
    els.url.value = tab.url || '';
  }

  els.catelog.value = config.defaultCategory || '';
  els.tags.value = config.defaultTags || '';

  if (!config.baseUrl || !config.token) {
    setStatus(`请先打开设置，填写 ${config.siteName || 'StarNav'} 地址和 Token。`, 'error');
    return;
  }

  setStatus('插件已就绪。');
  // 查重只在进入收藏视图时执行（见 switchTab），打开 popup 默认停在浏览视图，不打扰
}

async function autoFetchMeta() {
  const target = els.url.value.trim();
  if (!target) throw new Error('URL 不能为空');

  const result = await apiFetch('/api/site/preview?url=' + encodeURIComponent(target));
  const data = result?.data || {};

  if (data.title && !els.name.value.trim()) els.name.value = data.title;
  if (data.title) els.name.value = data.title;
  if (data.description) els.desc.value = data.description;
  if (data.favicon) els.logo.value = data.favicon;

  showDuplicate(data.duplicate);
  setStatus('网站信息已抓取。', 'success');
}

async function fetchFavicon() {
  const target = els.url.value.trim();
  if (!target) throw new Error('请先填写 URL');

  const result = await apiFetch('/api/favicon?url=' + encodeURIComponent(target));
  const favicon = result?.favicon || result?.data?.favicon || '';

  if (!favicon) {
    throw new Error('未找到合适图标');
  }

  els.logo.value = favicon;
  setStatus('已获取网站图标。', 'success');
}

async function suggestCategory() {
  const payload = getPayload();
  const result = await apiFetch('/api/submit/suggest-category', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const data = result?.data || {};
  const category = data.category || data.name || data.catelog || data.suggestion || '';
  if (category) {
    els.catelog.value = category;
    setStatus(`已推荐分类：${category}`, 'success');
  } else {
    setStatus('没有获得分类推荐。', 'warning');
  }
}

async function suggestTags() {
  const payload = getPayload();
  const result = await apiFetch('/api/submit/suggest-tags', {
    method: 'POST',
    body: JSON.stringify({ ...payload, limit: 8 }),
  });
  const data = result?.data || {};
  const tags = Array.isArray(data.tags) ? data.tags : Array.isArray(data) ? data : [];
  if (tags.length) {
    els.tags.value = tags.join(', ');
    setStatus(`已推荐标签：${tags.join(', ')}`, 'success');
  } else {
    setStatus('没有获得标签推荐。', 'warning');
  }
}

// 同一 URL 的查重只执行一次（避免收藏/浏览 tab 间来回切换重复请求）
let lastCheckedDuplicateUrl = '';

async function autoCheckDuplicate() {
  const target = els.url.value.trim();
  if (!target) return null;
  const result = await apiFetch('/api/sites/check-duplicate?url=' + encodeURIComponent(target));
  const duplicate = result?.duplicate || null;
  showDuplicate(duplicate);
  if (duplicate) setStatus('检测到重复书签，可检查后决定是否强制保存。', 'warning');
  else setStatus('未发现重复书签。', 'success');
  return duplicate;
}

async function saveBookmark({ force = false } = {}) {
  const payload = getPayload();

  if (!payload.name || !payload.url) {
    throw new Error('名称和 URL 不能为空');
  }

  const path = `/api/sites${force ? '?force=true' : ''}`;
  const result = await apiFetch(path, {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  showDuplicate(null);
  setStatus(`已保存到 ${config.siteName || 'StarNav'}：${payload.name}`, 'success');
  return result;
}

// 展示同步结果：统计 + 失败明细（url + reason）
function renderSyncResult(data) {
  const stats = data.stats || {};
  const failedItems = Array.isArray(data.failedItems) ? data.failedItems : [];
  const count = (n) => n ?? 0;

  let html = `新增 ${count(stats.added)} · 更新 ${count(stats.updated)} · 删除 ${count(stats.deleted)} · 跳过 ${count(stats.skipped)} · 失败 ${count(stats.failed)}`;

  if (failedItems.length) {
    html += '<div style="margin-top: 8px; padding-top: 8px; max-height: 132px; overflow-y: auto; border-top: 1px dashed var(--border);">';
    html += failedItems.map((f) => {
      const url = escapeHTML(f.url || '未知地址');
      const reason = escapeHTML(f.reason || '未知原因');
      return `<div style="padding: 3px 0; font-size: 12px; word-break: break-all;"><span style="color: var(--danger);">${url}</span><span style="color: var(--muted);"> — ${reason}</span></div>`;
    }).join('');
    html += '</div>';
  }

  els.syncResult.innerHTML = html;
  els.syncResult.style.display = 'block';
}

async function syncBookmarks() {
  const tree = await chrome.bookmarks.getTree();
  const items = flattenBookmarks(tree);

  if (!items.length) {
    setStatus('未发现可同步的书签', 'warning');
    return false;
  }

  const result = await apiFetch('/api/sync/bookmarks', {
    method: 'POST',
    body: JSON.stringify({ items, source: 'extension' }),
  });

  renderSyncResult(result?.data || {});
  setStatus('同步完成。', 'success');
  return true;
}

async function runAction(button, action) {
  button.disabled = true;
  setStatus('处理中...');
  try {
    await action();
  } catch (error) {
    if (error.status === 409 && error.data?.duplicate) {
      showDuplicate(error.data.duplicate);
      setStatus(error.message || '检测到重复书签。', 'warning');
    } else {
      setStatus(error.message || '操作失败。', 'error');
    }
  } finally {
    button.disabled = false;
  }
}

els.fetchBtn.addEventListener('click', () => runAction(els.fetchBtn, autoFetchMeta));
els.fetchFaviconBtn.addEventListener('click', () => runAction(els.fetchFaviconBtn, fetchFavicon));
els.suggestCategoryBtn.addEventListener('click', () => runAction(els.suggestCategoryBtn, suggestCategory));
els.suggestTagsBtn.addEventListener('click', () => runAction(els.suggestTagsBtn, suggestTags));
els.checkDuplicateBtn.addEventListener('click', () => runAction(els.checkDuplicateBtn, autoCheckDuplicate));
els.saveBtn.addEventListener('click', () => runAction(els.saveBtn, () => saveBookmark({ force: false })));
els.forceSaveBtn.addEventListener('click', () => runAction(els.forceSaveBtn, () => saveBookmark({ force: true })));
els.optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

els.syncBtn.addEventListener('click', async () => {
  els.syncBtn.disabled = true;
  els.syncResult.style.display = 'none';
  setStatus('同步中...');
  try {
    // 展平结果为 0 条时保持禁用（无书签可同步）
    if (await syncBookmarks()) {
      els.syncBtn.disabled = false;
    }
  } catch (error) {
    els.syncBtn.disabled = false;
    if (error.status === 400) {
      // 空快照保护等：展示服务端返回的 message
      setStatus(error.message || '同步未执行。', 'warning');
    } else {
      setStatus(error.message || '同步失败。', 'error');
    }
  }
});

els.url.addEventListener('change', () => {
  lastCheckedDuplicateUrl = els.url.value.trim();
  showDuplicate(null);
  autoCheckDuplicate().catch(() => {});
});

// 插件内搜索逻辑
const searchInput = document.getElementById('pluginSearchInput');
const searchResults = document.getElementById('pluginSearchResults');

if (searchInput && searchResults) {
  let debounceTimer;
  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const keyword = searchInput.value.trim();
    if (!keyword) {
      searchResults.style.display = 'none';
      searchResults.innerHTML = '';
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const result = await apiFetch(`/api/config?keyword=${encodeURIComponent(keyword)}&pageSize=10`);
        const list = result?.data || [];
        if (!list.length) {
          searchResults.style.display = 'block';
          searchResults.innerHTML = '<div style="padding: 6px; color: var(--muted); font-size: 12px; text-align: center;">未找到匹配的书签</div>';
          return;
        }

        searchResults.style.display = 'block';
        searchResults.innerHTML = list.map(item => {
          const name = escapeHTML(item.name || '未命名');
          const url = escapeHTML(item.url || '');
          const catelog = escapeHTML(item.catelog || '未分类');
          return `
            <div class="search-item" style="padding: 6px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.2s;" data-url="${url}">
              <div style="font-weight: bold; font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
              <div style="font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${catelog} · ${url}</div>
            </div>
          `;
        }).join('');

        // 绑定点击事件
        searchResults.querySelectorAll('.search-item').forEach(item => {
          item.addEventListener('click', () => {
            const targetUrl = item.dataset.url;
            if (targetUrl) {
              chrome.tabs.create({ url: targetUrl });
            }
          });
          item.addEventListener('mouseover', () => {
            item.style.background = 'var(--bg)';
          });
          item.addEventListener('mouseout', () => {
            item.style.background = 'transparent';
          });
        });
      } catch (err) {
        searchResults.style.display = 'block';
        searchResults.innerHTML = `<div style="padding: 6px; color: var(--danger); font-size: 12px; text-align: center;">搜索失败: ${err.message}</div>`;
      }
    }, 300);
  });
}

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
    // 进入收藏视图才执行查重；同一 URL 不重复请求（URL 变化由 change 事件负责）
    const target = els.url.value.trim();
    if (target && target !== lastCheckedDuplicateUrl) {
      lastCheckedDuplicateUrl = target;
      autoCheckDuplicate().catch(() => {});
    }
  } else {
    // 离开收藏视图清掉查重/收藏状态残留
    setStatus('');
  }
}

els.tabBrowse.addEventListener('click', () => switchTab(els.tabBrowse));
els.tabCollect.addEventListener('click', () => switchTab(els.tabCollect));
els.tabSync.addEventListener('click', () => switchTab(els.tabSync));

// ===== 站内书签浏览 =====
const BROWSE_CACHE_KEY = 'browse:cache:v1';
const BROWSE_CACHE_DEFAULT_MINUTES = 5;

const browseState = {
  page: 1,
  pageSize: 30,
  keyword: '',
  catelog: '',
  sort: '',
  total: 0,
  items: [],
  loading: false,
};

// 缓存签名：不含 page（缓存代表第一页视图，page 单独恢复）
function browseSignature() {
  return [browseState.keyword, browseState.catelog, browseState.sort].join('|');
}

function effectiveCacheMinutes() {
  const minutes = Number(config.browseCacheMinutes);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : BROWSE_CACHE_DEFAULT_MINUTES;
}

async function readBrowseCache() {
  try {
    const data = await chrome.storage.local.get(BROWSE_CACHE_KEY);
    return data[BROWSE_CACHE_KEY] || null;
  } catch {
    return null;
  }
}

async function writeBrowseCache(payload) {
  try {
    await chrome.storage.local.set({ [BROWSE_CACHE_KEY]: payload });
  } catch {
    // 写失败不影响浏览
  }
}

function isBrowseCacheFresh(cache) {
  const minutes = effectiveCacheMinutes();
  if (!cache || minutes <= 0) return false;
  return Date.now() - (cache.fetchedAt || 0) < minutes * 60 * 1000;
}

const BROWSE_AVATAR_COLORS = ['#8b5cf6', '#f5c26b', '#22d3ee', '#f472b6', '#34d399', '#60a5fa', '#fb923c', '#a78bfa'];

function browseAvatarColor(text) {
  let hash = 0;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return BROWSE_AVATAR_COLORS[hash % BROWSE_AVATAR_COLORS.length];
}

function browseHostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || '';
  }
}

// /api/config 响应：data 为站点数组 + 顶层 total；兼容 data.list 形态
function extractSiteList(result) {
  const data = result && result.data;
  if (Array.isArray(data)) return { list: data, total: Number(result.total) || data.length };
  if (data && Array.isArray(data.list)) return { list: data.list, total: Number(data.total != null ? data.total : result.total) || data.list.length };
  return { list: [], total: 0 };
}

function renderBrowseStatus(message, type = '') {
  els.browseStatus.textContent = message;
  els.browseStatus.style.color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '';
}

function browseSkeletonHTML() {
  let html = '';
  for (let i = 0; i < 3; i++) {
    html += '<div class="browse-skeleton"><span class="sk-avatar"></span><span class="sk-line"></span></div>';
  }
  return html;
}

function renderBrowseItem(item) {
  const name = String(item.name || item.title || '').trim() || '未命名';
  const url = item.url || '';
  const letter = (name.charAt(0) || '?').toUpperCase();
  const color = browseAvatarColor(name);
  const catelog = String(item.catelog || '').trim();
  const logoHtml = item.logo
    ? `<img class="browse-logo" src="${escapeHTML(item.logo)}" alt="" loading="lazy" data-letter="${escapeHTML(letter)}" data-color="${color}">`
    : `<span class="browse-logo-placeholder" style="--star-color:${color}"><b>${escapeHTML(letter)}</b><i>✦</i></span>`;
  return `
    <div class="browse-item" data-url="${escapeHTML(url)}" title="${escapeHTML(url)}">
      ${logoHtml}
      <div class="browse-item-body">
        <div class="browse-item-title">${escapeHTML(name)}</div>
        <div class="browse-item-meta">
          ${catelog ? `<span class="browse-chip">${escapeHTML(catelog)}</span>` : ''}
          <span class="browse-item-host">${escapeHTML(browseHostOf(url))}</span>
        </div>
      </div>
    </div>
  `;
}

function renderBrowseList() {
  renderBrowseStatus('');
  if (!browseState.items.length) {
    const filtering = browseState.keyword || browseState.catelog;
    els.browseList.innerHTML = `<div class="browse-empty">${filtering ? '没有匹配的书签 — 清空搜索或换个分类试试' : '站里还没有书签 — 切到「收藏」添加第一个'}</div>`;
    return;
  }
  els.browseList.innerHTML = browseState.items.map(renderBrowseItem).join('');

  for (const itemEl of els.browseList.querySelectorAll('.browse-item')) {
    const targetUrl = itemEl.dataset.url;
    // logo 加载失败：隐藏图片并显示星标占位（MV3 CSP 禁止内联 onerror，改用监听器）
    const logoImg = itemEl.querySelector('img.browse-logo');
    if (logoImg) {
      logoImg.addEventListener('error', () => {
        const placeholder = document.createElement('span');
        placeholder.className = 'browse-logo-placeholder';
        placeholder.style.setProperty('--star-color', logoImg.dataset.color || '#8b5cf6');
        placeholder.innerHTML = `<b>${escapeHTML(logoImg.dataset.letter || '?')}</b><i>✦</i>`;
        logoImg.replaceWith(placeholder);
      }, { once: true });
    }
    if (targetUrl) {
      // 跃迁反馈：点击闪星芒后打开，避免"点了没反应"的错觉
      itemEl.addEventListener('click', () => {
        if (itemEl.classList.contains('jumping')) return;
        itemEl.classList.add('jumping');
        setTimeout(async () => {
          try {
            await chrome.tabs.create({ url: targetUrl, active: true });
          } catch (error) {
            renderBrowseStatus(error.message || '打开失败', 'error');
            itemEl.classList.remove('jumping');
            return;
          }
          window.close();
        }, 230);
      });
    }
  }
  observeBrowseMore();
}

function updateBrowseMore() {
  const hasMore = browseState.items.length < browseState.total;
  els.browseMore.style.display = hasMore ? 'block' : 'none';
  els.browseMore.textContent = '加载更多';
}

// 无限滚动：接近列表底部自动加载下一页。
// 一次性触发（触发后 disconnect），只有数据成功更新（renderBrowseList）才重新观察，
// 加载失败时保持断开，由「加载更多」按钮兜底重试，避免失败后自动连打请求。
let browseMoreObserver = null;
function observeBrowseMore() {
  if (browseMoreObserver) {
    browseMoreObserver.disconnect();
    browseMoreObserver = null;
  }
  updateBrowseMore();
  if (browseState.items.length >= browseState.total) return;
  browseMoreObserver = new IntersectionObserver((entries) => {
    if (browseState.loading || !entries.some((e) => e.isIntersecting)) return;
    browseMoreObserver.disconnect();
    browseMoreObserver = null;
    loadBrowse(false).catch(() => {});
  }, { rootMargin: '0px 0px 180px 0px' });
  browseMoreObserver.observe(els.browseMore);
}

async function loadBrowse(reset = false, { skipCache = false, silent = false } = {}) {
  if (browseState.loading) return;
  browseState.loading = true;
  els.browseMore.disabled = true;

  if (reset) {
    if (!skipCache) {
      const cache = await readBrowseCache();
      if (cache && cache.signature === browseSignature() && isBrowseCacheFresh(cache)) {
        browseState.total = cache.total;
        browseState.items = cache.items;
        browseState.page = cache.page || 2;
        if (Array.isArray(cache.categories)) {
          browseCategories = normalizeCategories(cache.categories);
          renderCategories();
        }
        renderBrowseList();
        browseState.loading = false;
        updateBrowseMore();
        els.browseMore.disabled = false;
        return;
      }
    }
    browseState.page = 1;
    // silent：stale-while-revalidate 静默刷新，不清空已显示的旧数据、不闪骨架屏
    if (!silent) {
      browseState.items = [];
      browseState.total = 0;
      renderBrowseStatus('');
      els.browseList.innerHTML = browseSkeletonHTML();
    }
  } else {
    els.browseMore.textContent = '加载中...';
  }

  const params = new URLSearchParams({
    page: String(browseState.page),
    pageSize: String(browseState.pageSize),
    keyword: browseState.keyword,
    catalog: browseState.catelog,
    sort: browseState.sort,
  });

  try {
    const result = await apiFetch(`/api/config?${params.toString()}`);
    const { list, total } = extractSiteList(result);
    browseState.total = total;
    browseState.items = reset ? list : browseState.items.concat(list);
    browseState.page += 1;
    renderBrowseList();
    if (reset) {
      // 拉取到新数据即替换本地缓存（含分类），下次打开命中缓存直接显示
      await writeBrowseCache({ signature: browseSignature(), fetchedAt: Date.now(), items: list, total, page: browseState.page, categories: browseCategories });
    }
  } catch (error) {
    if (reset) els.browseList.innerHTML = '';
    if (error.status === 401) {
      renderBrowseStatus('Token 无效，请到设置页重新填写', 'error');
    } else {
      renderBrowseStatus(error.message || (reset ? '加载失败' : '加载更多失败'), 'error');
    }
  } finally {
    browseState.loading = false;
    updateBrowseMore();
    els.browseMore.disabled = false;
  }
}

let browseCategories = [];

// 打开浏览视图：缓存存在即先渲染（含分类），过期缓存后台静默刷新，
// 无缓存才走完整拉取（先分类后列表，保证缓存带分类）。
async function loadBrowseView() {
  const cache = await readBrowseCache();
  if (cache && cache.signature === browseSignature()) {
    browseState.total = cache.total;
    browseState.items = cache.items;
    browseState.page = cache.page || 2;
    if (Array.isArray(cache.categories)) browseCategories = normalizeCategories(cache.categories);
    renderBrowseList();
    renderCategories();
    updateBrowseMore();
    if (!isBrowseCacheFresh(cache)) {
      // stale-while-revalidate：先显示旧数据，后台静默刷新
      loadCategories().catch(() => {});
      loadBrowse(true, { skipCache: true, silent: true }).catch(() => {});
    }
    return;
  }
  await loadCategories();
  await loadBrowse(true);
}

// 展平分类树为 [{ name, level }]，渲染父子层级；保持服务端排序
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

// 兼容旧缓存格式（扁平字符串数组 → 叶子节点）
function normalizeCategories(cats) {
  if (!Array.isArray(cats)) return [];
  return cats
    .map((c) => (typeof c === 'string'
      ? { name: c.trim(), level: 0 }
      : { name: String(c.name || '').trim(), level: Number(c.level) || 0 }))
    .filter((c) => c.name);
}

async function loadCategories() {
  try {
    // tree 接口返回父子层级（/api/categories 是扁平列表，插件渲染需要层级）
    const result = await apiFetch('/api/categories/tree');
    const tree = Array.isArray(result && result.data) ? result.data : [];
    browseCategories = flattenCategoryTree(tree);
  } catch {
    browseCategories = [];
  }
  renderCategories();
}

// 当前展开的分类名集合（点父分类旁的 ▸/▾ 切换；选中子分类时祖先自动展开）
const expandedCategories = new Set();

// 收集 flat 列表中某分类的全部祖先名（用于自动展开）
function ancestorsOf(cats, name) {
  const idx = cats.findIndex((c) => c.name === name);
  if (idx < 0) return [];
  const out = [];
  let level = cats[idx].level;
  for (let j = idx - 1; j >= 0; j -= 1) {
    if (cats[j].level < level) {
      out.push(cats[j].name);
      level = cats[j].level;
      if (level === 0) break;
    }
  }
  return out;
}

// 扁平 [{name, level}] 构建树（用栈：level n 挂到最近的 level n-1 节点下）
function buildCategoryTree(flat) {
  const root = [];
  const stack = [{ name: '', level: -1, children: root }];
  for (const c of flat) {
    while (stack.length && stack[stack.length - 1].level >= c.level) stack.pop();
    const node = { name: c.name, level: c.level, children: [] };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

const FOLDER_ICON_SVG = '<svg class="cat-folder-icon" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M2 6a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6z"/></svg>';

// 顶层节点渲染：只出按钮行（有子时带 ▸/▾ 切换），子分类统一进下方子区块
function renderCategoryRow(node) {
  const isActive = browseState.catelog === node.name;
  const hasChildren = node.children.length > 0;
  const expanded = expandedCategories.has(node.name);
  const catBtn = `<button type="button" class="browse-cat${isActive ? ' active' : ''}" data-cat="${escapeHTML(node.name)}">${FOLDER_ICON_SVG}${escapeHTML(node.name)}</button>`;
  if (!hasChildren) return catBtn;
  return `<div class="browse-cat-row">${catBtn}<button type="button" class="browse-cat-toggle" data-expand="${escapeHTML(node.name)}" title="${expanded ? '收起子分类' : '展开子分类'}">${expanded ? '▾' : '▸'}</button></div>`;
}

// 收集展开节点的子分类，按父分类分组（每组横向 wrap，组间不混排）
function collectCategoryGroups(tree, out) {
  for (const node of tree) {
    if (!node.children.length || !expandedCategories.has(node.name)) continue;
    const items = [];
    for (const child of node.children) pushChildCategory(child, items, 0);
    out.push({ name: node.name, items });
  }
}

function pushChildCategory(child, out, level) {
  const isActive = browseState.catelog === child.name;
  const hasChildren = child.children.length > 0;
  const expanded = hasChildren && expandedCategories.has(child.name);
  const indent = `${(level + 1) * 16}px`;
  const btn = `<button type="button" class="browse-cat browse-cat-child${isActive ? ' active' : ''}" data-cat="${escapeHTML(child.name)}" style="margin-left:${indent}">${FOLDER_ICON_SVG}${escapeHTML(child.name)}</button>`;
  out.push(hasChildren
    ? `<span class="browse-cat-row">${btn}<button type="button" class="browse-cat-toggle" data-expand="${escapeHTML(child.name)}" title="${expanded ? '收起子分类' : '展开子分类'}">${expanded ? '▾' : '▸'}</button></span>`
    : btn);
  if (expanded) {
    for (const grand of child.children) pushChildCategory(grand, out, level + 1);
  }
}

function renderCategories() {
  const flat = [{ name: '', level: 0 }, ...browseCategories];
  const tree = buildCategoryTree(flat);

  // 当前筛选分类若是子分类，且用户没有手动展开任何父分类时，
  // 展开其祖先链保证按钮可见；用户手动展开后尊重手风琴（只显示一个）
  if (browseState.catelog && expandedCategories.size === 0) {
    for (const name of ancestorsOf(flat, browseState.catelog)) expandedCategories.add(name);
  }

  els.browseCats.innerHTML = tree.map((node) => renderCategoryRow(node)).join('');

  const groups = [];
  collectCategoryGroups(tree, groups);
  els.browseCatChildren.innerHTML = groups.map((group) => `
    <div class="browse-cat-group">
      <div class="browse-cat-group-label">${FOLDER_ICON_SVG}${escapeHTML(group.name)}</div>
      <div class="browse-cat-group-items">${group.items.join('')}</div>
    </div>
  `).join('');
  els.browseCatChildren.style.display = groups.length ? 'block' : 'none';

  const bind = (root) => {
    for (const btn of root.querySelectorAll('.browse-cat')) {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat || '';
        if (browseState.catelog === cat) return;
        browseState.catelog = cat;
        renderCategories();
        loadBrowse(true);
      });
    }
    for (const btn of root.querySelectorAll('.browse-cat-toggle')) {
      btn.addEventListener('click', () => {
        const name = btn.dataset.expand;
        // 手风琴：同一时间只展开一个父分类，点另一个时自动收起前一个；
        // 再点当前展开的则收起（回到仅顶层）
        if (expandedCategories.has(name)) {
          expandedCategories.delete(name);
        } else {
          expandedCategories.clear();
          expandedCategories.add(name);
        }
        renderCategories();
      });
    }
  };
  bind(els.browseCats);
  bind(els.browseCatChildren);
}

let browseSearchTimer = null;
els.browseSearch.addEventListener('input', () => {
  clearTimeout(browseSearchTimer);
  browseSearchTimer = setTimeout(() => {
    const keyword = els.browseSearch.value.trim();
    if (keyword === browseState.keyword) return;
    browseState.keyword = keyword;
    loadBrowse(true);
  }, 300);
});

els.browseSort.addEventListener('change', () => {
  const sort = els.browseSort.value;
  if (sort === browseState.sort) return;
  browseState.sort = sort;
  loadBrowse(true);
});

els.browseRefresh.addEventListener('click', async () => {
  // 立即拉取：跳过缓存，先刷分类再刷列表，成功后替换本地缓存
  await loadCategories();
  await loadBrowse(true, { skipCache: true });
});
els.browseMore.addEventListener('click', () => loadBrowse(false));

initPopup();