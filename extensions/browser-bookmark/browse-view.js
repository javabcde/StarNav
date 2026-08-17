// 站内书签浏览视图（In-Site Browsing，术语见 CONTEXT.md）：
// 全量缓存读取/写入、客户端过滤分页、分类手风琴、无限滚动、视图持久化。
// 纯逻辑在 popup-logic.js（BrowseLogic），本文件只做 DOM 挂接与状态持有。
// UMD：浏览器经典 script 下挂 globalThis.StarNavBrowseView，node 测试走 module.exports。
(function (global) {
  'use strict';

  function createBrowseView(ctx) {
    const { els, Contract, BrowseLogic, apiFetch, escapeHTML, localStorage } = ctx;

    const BROWSE_CACHE_KEY = Contract.BROWSE_CACHE_KEY;
    const BROWSE_CACHE_DEFAULT_MINUTES = Contract.BROWSE_CACHE_DEFAULT_MINUTES;

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

    function effectiveCacheMinutes() {
      const minutes = Number(ctx.config().browseCacheMinutes);
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
        <div class="browse-item" data-id="${escapeHTML(String(item.id ?? ''))}" data-url="${escapeHTML(url)}" title="${escapeHTML(url)}">
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
            // 图标自动补全：无图标书签 fire-and-forget 上报 background 补全
            // （popup 关闭后由 background 接管；有图标/未配置则 background 静默跳过）
            const siteId = itemEl.dataset.id;
            if (siteId && !itemEl.querySelector('img.browse-logo')) {
              chrome.runtime.sendMessage({ type: Contract.MESSAGE_TYPES.ENSURE_FAVICON, siteId }).catch(() => {});
            }
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
    // 在途全量拉取的 promise（视图级）：避免重拉被 loading 锁静默跳过
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

    // 全量拉取：/api/config?all=1 + 分类树 并行（构建统一走 BrowseLogic.fetchFullBrowseCache），
    // 写新格式缓存并就地渲染
    async function loadFullCache({ silent = false } = {}) {
      if (browseState.loading) return browseLoadInFlight;
      browseState.loading = true;
      els.browseMore.disabled = true;

      const task = (async () => {
        try {
          const cache = await BrowseLogic.fetchFullBrowseCache(apiFetch, { minutes: effectiveCacheMinutes() });
          await writeBrowseCache(cache);

          useFullCache(cache); // 内部经 applyBrowseView 统一保存视图并设置 browseCategories
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
      // 直属书签视图（ADR-0013 双键）：只按分类自身过滤，不走子孙闭包
      const catelogNames = browseState.catelog
        ? (browseState.direct ? new Set([browseState.catelog]) : BrowseLogic.collectCategoryNames(browseCategories, browseState.catelog))
        : null;
      const filtered = BrowseLogic.filterBrowseItems(browseState.cacheItems, browseState, catelogNames);
      browseState.total = filtered.length;
      const pageItems = BrowseLogic.paginateItems(filtered, browseState.page, browseState.pageSize);
      browseState.items = (append && browseState.page > 1) ? browseState.items.concat(pageItems) : pageItems;
      renderBrowseList();
      // 视图持久化：分类/搜索/排序切换都经 applyBrowseView，统一在此保存
      // （此前只在 useFullCache 保存 → 切分类后关闭再打开会恢复旧分类）
      saveBrowseView();
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
    const BROWSE_VIEW_KEY = Contract.STORAGE_KEYS.BROWSE_VIEW;
    function saveBrowseView() {
      try {
        localStorage.setItem(BROWSE_VIEW_KEY, JSON.stringify({
          catelog: browseState.catelog,
          keyword: browseState.keyword,
          sort: browseState.sort,
          direct: browseState.direct,
          ts: Date.now(),
        }));
      } catch {
        // 存储不可用不影响浏览
      }
    }
    function restoreBrowseView() {
      try {
        const saved = BrowseLogic.deserializeView(localStorage.getItem(BROWSE_VIEW_KEY));
        if (!saved) return;
        browseState.catelog = saved.catelog;
        browseState.keyword = saved.keyword;
        browseState.sort = saved.sort;
        browseState.direct = Boolean(saved.direct);
        // 存储不可用（隐私模式等）时保持默认视图
      } catch {
        // 解析失败用默认视图
      }
    }

    // 当前展开的分类名集合（点父分类旁的 ▸/▾ 切换；选中子分类时祖先自动展开）
    let expandedCategories = new Set();
    // 手动收起标志：用户点 ▾ 收起后，本次会话内不再自动注入祖先链
    // （否则筛选子分类时收起父分类会被 injectAncestors 立即展开）
    let suppressAncestorInjection = false;

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
      // 直属书签聚合节点（ADR-0013）：data-direct/data-parent 双键，点击后只显示父分类直属书签
      const directAttrs = item.direct ? ` data-direct="1" data-parent="${escapeHTML(item.parent)}"` : '';
      const btn = `<button type="button" class="browse-cat browse-cat-child${item.active ? ' active' : ''}" data-cat="${escapeHTML(item.name)}"${directAttrs} style="margin-left:${indent}">${FOLDER_ICON_SVG}${escapeHTML(item.name)}</button>`;
      return item.hasChildren
        ? `<span class="browse-cat-row">${btn}<button type="button" class="browse-cat-toggle" data-expand="${escapeHTML(item.name)}" title="${item.expanded ? '收起子分类' : '展开子分类'}">${item.expanded ? '▾' : '▸'}</button></span>`
        : btn;
    }

    function renderCategories() {
      const flat = [{ name: '', level: 0 }, ...browseCategories];
      const tree = BrowseLogic.buildCategoryTree(flat);
      if (!suppressAncestorInjection) {
        expandedCategories = BrowseLogic.injectAncestors(expandedCategories, browseState.catelog, flat, Boolean(browseState.direct));
      }

      els.browseCats.innerHTML = tree.map((node) => renderCategoryRow(node)).join('');

      const groups = BrowseLogic.collectCategoryGroups(tree, expandedCategories, browseState.catelog, browseState.direct);
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
            const direct = btn.dataset.direct === '1';
            const parent = btn.dataset.parent || '';
            if (browseState.catelog === cat && Boolean(browseState.direct) === direct) return;
            // 手风琴语义：点任意分类按钮都收起当前展开（与点箭头一致）；
            // 若点击的是子分类，renderCategories 会按祖先链自动恢复其父的展开
            expandedCategories.clear();
            Object.assign(browseState, BrowseLogic.applyBrowseFilter(browseState, direct ? { catelog: parent, direct: true } : { catelog: cat, direct: false }));
            renderCategories();
            // 客户端过滤（守卫：缓存未就绪先触发全量拉取）
            ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
          });
        }
        for (const btn of root.querySelectorAll('.browse-cat-toggle')) {
          btn.addEventListener('click', () => {
            const name = btn.dataset.expand;
            // 手风琴：同一时间只展开一个父分类，点另一个时自动收起前一个；
            // 再点当前展开的则收起（回到仅顶层）——含「手动收起后抑制祖先注入」
            // 的转移规则见 popup-logic.js（toggleCategoryInState / collapseChangedFilter）
            const nextAccordion = BrowseLogic.toggleCategoryInState({ expanded: expandedCategories }, name);
            expandedCategories = nextAccordion.expanded;
            suppressAncestorInjection = nextAccordion.suppressAncestorInjection;
            // 收起时若筛选在该父分类的子孙下，切回父分类（显示父+子孙全部）
            const nextView = suppressAncestorInjection
              ? BrowseLogic.collapseChangedFilter(browseState, name, browseCategories)
              : null;
            if (nextView) Object.assign(browseState, nextView);
            renderCategories();
            if (nextView) applyBrowseView();
          });
        }
      };
      bind(els.browseCats);
      bind(els.browseCatChildren);
    }

    let browseSearchTimer = null;

    /**
     * 挂载浏览视图：绑定交互监听 + 恢复上次视图 + 加载全量缓存。
     * 视图生命周期 seam：popup 壳在启动时调用一次（重复调用会重复绑定监听）。
     */
    function mount() {
      els.browseSearch.addEventListener('input', () => {
        clearTimeout(browseSearchTimer);
        browseSearchTimer = setTimeout(() => {
          const keyword = els.browseSearch.value.trim();
          if (keyword === browseState.keyword) return;
          Object.assign(browseState, BrowseLogic.applyBrowseFilter(browseState, { keyword }));
          ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
        }, 300);
      });

      els.browseSort.addEventListener('change', () => {
        const sort = els.browseSort.value;
        if (sort === browseState.sort) return;
        Object.assign(browseState, BrowseLogic.applyBrowseFilter(browseState, { sort }));
        ensureBrowseCache().then(() => applyBrowseView()).catch(() => {});
      });

      els.browseRefresh.addEventListener('click', async () => {
        // 强制刷新：跳过缓存重新拉全量（静默，不闪骨架屏，成功后覆盖渲染）
        renderBrowseStatus('刷新中...', '');
        const ok = await loadFullCache({ silent: true });
        if (ok) renderBrowseStatus('');
      });

      els.browseMore.addEventListener('click', () => {
        Object.assign(browseState, BrowseLogic.applyBrowsePage(browseState, browseState.page + 1));
        applyBrowseView({ append: true });
      });

      // 初始化失败重试：browseList 一次性事件委托（不随渲染重复绑定）
      els.browseList.addEventListener('click', (e) => {
        if (!e.target.closest('.browse-retry')) return;
        showBrowseInitState();
        loadFullCache().catch(() => {});
      });

      // 恢复上次浏览视图（分类/搜索/排序），打开后立即生效于本地过滤
      restoreBrowseView();
      if (els.browseSearch) els.browseSearch.value = browseState.keyword;
      if (els.browseSort) els.browseSort.value = browseState.sort;
      // 站内浏览：缓存命中直接显示本地数据，未命中/过期才拉取（错误在浏览视图内展示）
      loadBrowseView().catch(() => {});
    }

    function onEnter() {
      // 浏览视图无进入副作用（缓存加载在 mount 中启动）
    }

    function onLeave() {
      // 无离开清理
    }

    return {
      mount,
      onEnter,
      onLeave,
      /** 收藏/同步成功后的缓存刷新钩子（供壳接给收藏/同步视图） */
      refreshAfterCacheMutation: refreshBrowseCacheAfterMutation,
    };
  }

  const BrowseView = { create: createBrowseView };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrowseView;
  } else {
    global.StarNavBrowseView = BrowseView;
  }
})(typeof self !== 'undefined' ? self : globalThis);
