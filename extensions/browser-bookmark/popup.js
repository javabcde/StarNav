const els = {
  name: document.getElementById('name'),
  url: document.getElementById('url'),
  desc: document.getElementById('desc'),
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
  if (!baseUrl) throw new Error('请先在设置中填写 StarNav 地址');
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
    'browseCacheMinutes',
  ]);
  const localData = await chrome.storage.local.get([
    'categories',
    'tags',
  ]);

  config = { ...syncData, ...localData };

  renderDatalist(els.categoryList, config.categories || [], (item) => item.name || item.catelog || item);
  renderDatalist(els.tagList, config.tags || [], (item) => item.name || item.tag || item);
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
    setStatus('请先打开设置，填写 StarNav 地址和 Token。', 'error');
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
  setStatus(`已保存到 StarNav：${payload.name}`, 'success');
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

const BROWSE_AVATAR_COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#4f46e5', '#ca8a04'];

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
  const logoHtml = item.logo
    ? `<img class="browse-logo" src="${escapeHTML(item.logo)}" alt="" loading="lazy" data-letter="${escapeHTML(letter)}" data-color="${color}">`
    : `<span class="browse-logo-placeholder" style="background:${color}">${escapeHTML(letter)}</span>`;
  return `
    <div class="browse-item" data-url="${escapeHTML(url)}" title="${escapeHTML(url)}">
      ${logoHtml}
      <div class="browse-item-body">
        <div class="browse-item-title">${escapeHTML(name)}</div>
        <div class="browse-item-host">${escapeHTML(browseHostOf(url))}</div>
      </div>
    </div>
  `;
}

function renderBrowseList() {
  renderBrowseStatus('');
  if (!browseState.items.length) {
    els.browseList.innerHTML = '<div class="browse-empty">未找到书签</div>';
    return;
  }
  els.browseList.innerHTML = browseState.items.map(renderBrowseItem).join('');

  for (const itemEl of els.browseList.querySelectorAll('.browse-item')) {
    const targetUrl = itemEl.dataset.url;
    // logo 加载失败：隐藏图片并显示首字母占位（MV3 CSP 禁止内联 onerror，改用监听器）
    const logoImg = itemEl.querySelector('img.browse-logo');
    if (logoImg) {
      logoImg.addEventListener('error', () => {
        const placeholder = document.createElement('span');
        placeholder.className = 'browse-logo-placeholder';
        placeholder.textContent = logoImg.dataset.letter || '?';
        placeholder.style.background = logoImg.dataset.color || '#2563eb';
        logoImg.replaceWith(placeholder);
      }, { once: true });
    }
    if (targetUrl) {
      itemEl.addEventListener('click', async () => {
        try {
          await chrome.tabs.create({ url: targetUrl, active: true });
        } catch (error) {
          renderBrowseStatus(error.message || '打开失败', 'error');
          return;
        }
        window.close();
      });
    }
  }
}

function updateBrowseMore() {
  const hasMore = browseState.items.length < browseState.total;
  els.browseMore.style.display = hasMore ? 'block' : 'none';
  els.browseMore.textContent = '加载更多';
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
          browseCategories = cache.categories;
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
    if (Array.isArray(cache.categories)) browseCategories = cache.categories;
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

async function loadCategories() {
  try {
    const result = await apiFetch('/api/categories');
    const raw = Array.isArray(result && result.data) ? result.data : [];
    browseCategories = raw.map((c) => (c && String(c.name || '')).trim()).filter(Boolean);
  } catch {
    browseCategories = [];
  }
  renderCategories();
}

function renderCategories() {
  const cats = ['', ...browseCategories];
  els.browseCats.innerHTML = cats.map((cat) => {
    const isActive = browseState.catelog === cat;
    return `<button type="button" class="browse-cat${isActive ? ' active' : ''}" data-cat="${escapeHTML(cat)}">${escapeHTML(cat || '全部')}</button>`;
  }).join('');

  for (const btn of els.browseCats.querySelectorAll('.browse-cat')) {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat || '';
      if (browseState.catelog === cat) return;
      browseState.catelog = cat;
      renderCategories();
      loadBrowse(true);
    });
  }
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