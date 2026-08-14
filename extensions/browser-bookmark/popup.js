const els = {
  name: document.getElementById('name'),
  url: document.getElementById('url'),
  desc: document.getElementById('desc'),
  appTitle: document.getElementById('appTitle'),
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

  // 恢复上次浏览视图（分类/搜索/排序），打开后立即生效于本地过滤
  restoreBrowseView();
  if (els.browseSearch) els.browseSearch.value = browseState.keyword;
  if (els.browseSort) els.browseSort.value = browseState.sort;

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
  // 异步更新浏览缓存：后台静默重拉当前视图，浏览 tab 下次打开即包含新书签
  refreshBrowseCacheAfterMutation();
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
  // 同步可能增删改书签，后台重拉浏览缓存保持一致
  refreshBrowseCacheAfterMutation();
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
  // 全量缓存（kind==='full'）就绪后：cacheItems 为全部可见书签，items 为过滤+分页切片
  cacheReady: false,
  cacheItems: [],
  cacheTotal: 0,
};

// 缓存判定见 popup-logic.js（BrowseLogic.decideBrowseView / isFullBrowseCache）

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
  return BrowseLogic.isBrowseCacheFresh(cache, effectiveCacheMinutes());
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

function renderBrowseStatus(message, type = '') {
  els.browseStatus.textContent = message;
  els.browseStatus.style.color = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '';
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
  // 已渲染 = page * pageSize（items 是当前页切片，不能拿当前页长度比较）
  const hasMore = BrowseLogic.browseHasMore(browseState.page, browseState.pageSize, browseState.total);
  els.browseMore.style.display = hasMore ? 'block' : 'none';
  els.browseMore.textContent = '加载更多';
}

// 无限滚动：接近列表底部自动翻页（客户端分页，本地切片）。
let browseMoreObserver = null;
function observeBrowseMore() {
  if (browseMoreObserver) {
    browseMoreObserver.disconnect();
    browseMoreObserver = null;
  }
  updateBrowseMore();
  if (!BrowseLogic.browseHasMore(browseState.page, browseState.pageSize, browseState.total)) return;
  browseMoreObserver = new IntersectionObserver((entries) => {
    if (browseState.loading || !entries.some((e) => e.isIntersecting)) return;
    browseMoreObserver.disconnect();
    browseMoreObserver = null;
    browseState.page += 1;
    applyBrowseView({ append: true });
  }, { rootMargin: '0px 0px 180px 0px' });
  browseMoreObserver.observe(els.browseMore);
}

// 收藏/同步成功后异步更新浏览缓存：等待在途拉取完成后重拉全量。
// 在途全量拉取的 promise（模块级）：避免重拉被 loading 锁静默跳过
let browseLoadInFlight = null;

async function refreshBrowseCacheAfterMutation() {
  const inFlight = browseLoadInFlight;
  if (inFlight) {
    try { await inFlight; } catch { /* 在途加载失败忽略，随后重拉兜底 */ }
  }
  // 重拉发生在保存提交之后（D1 强一致），新缓存必然包含刚保存的书签
  loadFullCache({ silent: true }).catch(() => {});
}

// 初始化态：骨架 + 文案（无缓存/旧格式首次打开时展示）
function showBrowseInitState() {
  els.browseStatus.textContent = '';
  els.browseMore.style.display = 'none';
  els.browseList.innerHTML = '<div class="browse-skeleton"><span class="sk-avatar"></span><span class="sk-line"></span></div>'
    + '<div class="browse-empty browse-init-hint">正在初始化书签…</div>';
}

// 全量拉取：/api/config?all=1 + 分类树 并行，写新格式缓存并就地渲染
async function loadFullCache({ silent = false } = {}) {
  if (browseState.loading) return browseLoadInFlight;
  browseState.loading = true;
  els.browseMore.disabled = true;

  const task = (async () => {
    try {
      const [listResult, catsResult] = await Promise.all([
        apiFetch('/api/config?all=1'),
        apiFetch('/api/categories/tree'),
      ]);
      const data = listResult && listResult.data;
      const items = Array.isArray(data) ? data : [];
      const total = Number(listResult.total != null ? listResult.total : items.length) || items.length;
      const tree = Array.isArray(catsResult && catsResult.data) ? catsResult.data : [];
      browseCategories = BrowseLogic.flattenCategoryTree(tree);

      const cache = {
        kind: 'full',
        fetchedAt: Date.now(),
        ttlMinutes: effectiveCacheMinutes(),
        items,
        total,
        categories: browseCategories,
      };
      await writeBrowseCache(cache);

      useFullCache(cache);
      saveBrowseView();
      return true;
    } catch (error) {
      // 非静默（首开/守卫/手动刷新）：渲染可点击重试；静默（后台刷新）失败
      // 不打断当前列表，仅状态条报错（用户可点刷新按钮）
      if (!silent) {
        els.browseList.innerHTML = '<div class="browse-empty browse-retry" role="button" tabindex="0">初始化失败，点击重试</div>';
      }
      if (error.status === 401) {
        renderBrowseStatus('Token 无效，请到设置页重新填写', 'error');
      } else {
        renderBrowseStatus(error.message || '加载失败', 'error');
      }
      return false;
    } finally {
      browseState.loading = false;
      els.browseMore.disabled = false;
    }
  })();

  browseLoadInFlight = task;
  try {
    return await task;
  } finally {
    if (browseLoadInFlight === task) browseLoadInFlight = null;
  }
}

// 使用新格式全量缓存：就位缓存数据并渲染当前视图
function useFullCache(cache) {
  browseState.cacheReady = true;
  browseState.cacheItems = cache.items || [];
  browseState.cacheTotal = Number(cache.total) || browseState.cacheItems.length;
  if (Array.isArray(cache.categories)) browseCategories = BrowseLogic.normalizeCategories(cache.categories);
  browseState.page = 1;
  renderCategories();
  applyBrowseView();
}

// 客户端过滤 + 分页渲染（守卫：仅全量缓存就绪时生效）。
// append=true 时把新页拼接到已渲染列表（无限滚动累积，可往上滚回前页）；
// 视图切换/重置（page=1）时替换为第一页
function applyBrowseView({ append = false } = {}) {
  if (!browseState.cacheReady) {
    showBrowseInitState();
    return;
  }
  const catelogNames = browseState.catelog
    ? collectCategoryNames(browseCategories, browseState.catelog)
    : null;
  const filtered = BrowseLogic.filterBrowseItems(browseState.cacheItems, browseState, catelogNames);
  browseState.total = filtered.length;
  const pageItems = BrowseLogic.paginateItems(filtered, browseState.page, browseState.pageSize);
  browseState.items = (append && browseState.page > 1) ? browseState.items.concat(pageItems) : pageItems;
  renderBrowseList();
}

// 收集分类及其全部子孙名（供客户端分类过滤，父分类含子孙书签）
function collectCategoryNames(flat, name) {
  const set = new Set();
  const tree = BrowseLogic.buildCategoryTree([{ name: '', level: 0 }, ...flat]);
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.name === name) {
        collectSubtree(n, set);
        return true;
      }
      if (walk(n.children)) return true;
    }
    return false;
  };
  walk(tree);
  return set;
}
function collectSubtree(node, set) {
  set.add(node.name);
  for (const c of node.children) collectSubtree(c, set);
}

// 打开浏览视图：新格式缓存新鲜 → 零请求渲染；过期 → 渲染 + 后台刷新；
// 无缓存/旧格式 → 初始化态拉全量重建
async function loadBrowseView() {
  const cache = await readBrowseCache();
  const decision = BrowseLogic.decideBrowseView(cache, effectiveCacheMinutes());
  if (!decision.render) {
    showBrowseInitState();
    await loadFullCache();
    return;
  }
  useFullCache(cache);
  if (decision.refresh) {
    loadFullCache({ silent: true }).catch(() => {});
  }
}

// 视图切换守卫：缓存未就绪时先触发全量拉取，就绪后立即本地过滤
async function ensureBrowseCache() {
  if (browseState.cacheReady) return true;
  await loadFullCache();
  return browseState.cacheReady;
}

let browseCategories = [];

// 上次浏览视图（分类/搜索/排序）：恢复后立即生效于本地过滤
const BROWSE_VIEW_KEY = 'browse:view:v1';
function saveBrowseView() {
  try {
    localStorage.setItem(BROWSE_VIEW_KEY, JSON.stringify({
      catelog: browseState.catelog,
      keyword: browseState.keyword,
      sort: browseState.sort,
      ts: Date.now(),
    }));
  } catch {
    // 存储不可用不影响浏览
  }
}
function restoreBrowseView() {
  try {
    const saved = JSON.parse(localStorage.getItem(BROWSE_VIEW_KEY) || 'null');
    if (!saved) return;
    browseState.catelog = String(saved.catelog || '');
    browseState.keyword = String(saved.keyword || '');
    browseState.sort = String(saved.sort || '');
  } catch {
    // 解析失败用默认视图
  }
}

// 展平分类树 / 兼容旧缓存格式见 popup-logic.js（BrowseLogic.flattenCategoryTree / normalizeCategories）

// 当前展开的分类名集合（点父分类旁的 ▸/▾ 切换；选中子分类时祖先自动展开）
let expandedCategories = new Set();

// 祖先收集 / 树构建 / 分组收集见 popup-logic.js（BrowseLogic）

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

// 子分类按钮 HTML（数据来自 BrowseLogic.collectCategoryGroups）
function renderChildCategoryItem(item) {
  const indent = `${(item.level + 1) * 16}px`;
  const btn = `<button type="button" class="browse-cat browse-cat-child${item.active ? ' active' : ''}" data-cat="${escapeHTML(item.name)}" style="margin-left:${indent}">${FOLDER_ICON_SVG}${escapeHTML(item.name)}</button>`;
  return item.hasChildren
    ? `<span class="browse-cat-row">${btn}<button type="button" class="browse-cat-toggle" data-expand="${escapeHTML(item.name)}" title="${item.expanded ? '收起子分类' : '展开子分类'}">${item.expanded ? '▾' : '▸'}</button></span>`
    : btn;
}

function renderCategories() {
  const flat = [{ name: '', level: 0 }, ...browseCategories];
  const tree = BrowseLogic.buildCategoryTree(flat);

  // 当前筛选分类若是子分类，且用户没有手动展开任何父分类时，
  // 展开其祖先链保证按钮可见；用户手动展开后尊重手风琴（只显示一个）
  expandedCategories = BrowseLogic.injectAncestors(expandedCategories, browseState.catelog, flat);

  els.browseCats.innerHTML = tree.map((node) => renderCategoryRow(node)).join('');

  const groups = BrowseLogic.collectCategoryGroups(tree, expandedCategories, browseState.catelog);
  els.browseCatChildren.innerHTML = groups.map((group) => `
    <div class="browse-cat-group">
      <div class="browse-cat-group-label">${FOLDER_ICON_SVG}${escapeHTML(group.name)}</div>
      <div class="browse-cat-group-items">${group.items.map(renderChildCategoryItem).join('')}</div>
    </div>
  `).join('');
  els.browseCatChildren.style.display = groups.length ? 'block' : 'none';

  const bind = (root) => {
    for (const btn of root.querySelectorAll('.browse-cat')) {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat || '';
        if (browseState.catelog === cat) return;
        // 手风琴语义：点任意分类按钮都收起当前展开（与点箭头一致）；
        // 若点击的是子分类，renderCategories 会按祖先链自动恢复其父的展开
        expandedCategories.clear();
        browseState.catelog = cat;
        browseState.page = 1;
        renderCategories();
        // 客户端过滤（守卫：缓存未就绪先触发全量拉取）
        ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
      });
    }
    for (const btn of root.querySelectorAll('.browse-cat-toggle')) {
      btn.addEventListener('click', () => {
        const name = btn.dataset.expand;
        // 手风琴：同一时间只展开一个父分类，点另一个时自动收起前一个；
        // 再点当前展开的则收起（回到仅顶层）——逻辑见 popup-logic.js
        expandedCategories = BrowseLogic.toggleCategory(expandedCategories, name);
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
    browseState.page = 1;
    ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
  }, 300);
});

els.browseSort.addEventListener('change', () => {
  const sort = els.browseSort.value;
  if (sort === browseState.sort) return;
  browseState.sort = sort;
  browseState.page = 1;
  ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
});

els.browseRefresh.addEventListener('click', async () => {
  // 强制刷新：跳过缓存重新拉全量（静默，不闪骨架屏，成功后覆盖渲染）
  renderBrowseStatus('刷新中...', '');
  const ok = await loadFullCache({ silent: true });
  if (ok) renderBrowseStatus('');
});
els.browseMore.addEventListener('click', () => {
  browseState.page += 1;
  applyBrowseView({ append: true });
});

// 初始化失败重试：browseList 一次性事件委托（不随渲染重复绑定）
els.browseList.addEventListener('click', (e) => {
  if (!e.target.closest('.browse-retry')) return;
  showBrowseInitState();
  loadFullCache().catch(() => {});
});

initPopup();