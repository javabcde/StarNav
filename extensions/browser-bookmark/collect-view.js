// 收藏视图（collect）：表单填写、抓取元数据、AI 建议、查重、保存、插件内搜索。
// 纯逻辑与状态机在 popup-logic.js（BrowseLogic）/ extension-contract.js（Contract）。
// UMD：浏览器经典 script 下挂 globalThis.StarNavCollectView，node 测试走 module.exports。
(function (global) {
  'use strict';

  function createCollectView(ctx) {
    const { els, Contract, apiFetch, setStatus, escapeHTML, getActiveTab } = ctx;

    let lastDuplicate = null;
    // 同一 URL 的查重只执行一次（避免收藏/浏览 tab 间来回切换重复请求）
    let lastCheckedDuplicateUrl = '';

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
      setStatus(`已保存到 ${ctx.config().siteName || 'StarNav'}：${payload.name}`, 'success');
      // 异步更新浏览缓存：后台静默重拉当前视图，浏览 tab 下次打开即包含新书签
      ctx.onCacheMutated();
      return result;
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

    // 插件内搜索逻辑（收藏视图顶部搜索框）
    function bindPluginSearch() {
      const searchInput = ctx.document.getElementById('pluginSearchInput');
      const searchResults = ctx.document.getElementById('pluginSearchResults');
      if (!searchInput || !searchResults) return;

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

    /**
     * 挂载收藏视图：绑定交互监听 + 用当前活动页预填名称/URL + 默认分类/标签。
     * popup 壳在启动时调用一次（重复调用会重复绑定监听）。
     */
    async function mount() {
      els.fetchBtn.addEventListener('click', () => runAction(els.fetchBtn, autoFetchMeta));
      els.fetchFaviconBtn.addEventListener('click', () => runAction(els.fetchFaviconBtn, fetchFavicon));
      els.suggestCategoryBtn.addEventListener('click', () => runAction(els.suggestCategoryBtn, suggestCategory));
      els.suggestTagsBtn.addEventListener('click', () => runAction(els.suggestTagsBtn, suggestTags));
      els.checkDuplicateBtn.addEventListener('click', () => runAction(els.checkDuplicateBtn, autoCheckDuplicate));
      els.saveBtn.addEventListener('click', () => runAction(els.saveBtn, () => saveBookmark({ force: false })));
      els.forceSaveBtn.addEventListener('click', () => runAction(els.forceSaveBtn, () => saveBookmark({ force: true })));

      els.url.addEventListener('change', () => {
        lastCheckedDuplicateUrl = els.url.value.trim();
        showDuplicate(null);
        autoCheckDuplicate().catch(() => {});
      });

      bindPluginSearch();

      // 当前活动页预填（与旧 initPopup 一致：await 阻塞预填，失败即中止后续默认值填充）
      const tab = await getActiveTab();
      if (tab) {
        els.name.value = tab.title || '';
        els.url.value = tab.url || '';
      }

      els.catelog.value = ctx.config().defaultCategory || '';
      els.tags.value = ctx.config().defaultTags || '';
    }

    function onEnter() {
      // 进入收藏视图才执行查重；同一 URL 不重复请求（URL 变化由 change 事件负责）
      const target = els.url.value.trim();
      if (target && target !== lastCheckedDuplicateUrl) {
        lastCheckedDuplicateUrl = target;
        autoCheckDuplicate().catch(() => {});
      }
    }

    function onLeave() {
      // 离开收藏视图清掉查重/收藏状态残留
      setStatus('');
    }

    return {
      mount,
      onEnter,
      onLeave,
      // 供测试/壳复用的最小行为面
      _handlers: { getPayload, saveBookmark, autoCheckDuplicate, showDuplicate },
    };
  }

  const CollectView = { create: createCollectView };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = CollectView;
  } else {
    global.StarNavCollectView = CollectView;
  }
})(typeof self !== 'undefined' ? self : globalThis);
