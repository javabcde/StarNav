// 插件纯逻辑层：浏览缓存决策、分类树/分组、手风琴状态机。
// 不碰 DOM / chrome API，可被 node:test 直接测试（tests/popup-logic.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.BrowseLogic，node 下走 module.exports。
(function (global) {
  'use strict';

  // 新格式全量缓存识别（旧格式/未知格式一律视为无缓存）
  function isFullBrowseCache(cache) {
    return Boolean(cache && cache.kind === 'full' && Array.isArray(cache.items));
  }

  // 缓存是否新鲜：minutes <= 0 视为不缓存（总是拉取）
  function isBrowseCacheFresh(cache, minutes, now) {
    if (!cache || !Number.isFinite(minutes) || minutes <= 0) return false;
    return (now || Date.now()) - (cache.fetchedAt || 0) < minutes * 60 * 1000;
  }

  /**
   * 打开浏览视图的决策（全量缓存语义）：
   * - 无缓存 / 旧格式（非 kind==='full'）→ render:false（初始化态拉全量重建）
   * - 新格式新鲜 → render + 零请求
   * - 新格式过期 → render + 后台刷新
   * @param {{kind?: string, fetchedAt?: number}|null} cache
   * @param {number} minutes 缓存 TTL 分钟数
   * @param {number} [now]
   * @returns {{render: boolean, refresh: boolean}}
   */
  function decideBrowseView(cache, minutes, now) {
    if (!isFullBrowseCache(cache)) return { render: false, refresh: false };
    return {
      render: true,
      refresh: !isBrowseCacheFresh(cache, minutes, now),
    };
  }

  // 契约常量取全局 Contract（extension-contract.js 先于本文件加载，
  // 见 popup.html 的 script 顺序与 background.js 的 importScripts 顺序）
  function contractDefaultCacheMinutes() {
    if (!global.Contract) {
      throw new Error('popup-logic 依赖全局 Contract：extension-contract.js 须先于 popup-logic.js 加载');
    }
    return global.Contract.BROWSE_CACHE_DEFAULT_MINUTES;
  }

  /**
   * 全量缓存构建器：并行拉取全量书签与分类树，归一 TTL 与 total 后组装
   * kind==='full' 全量缓存（形状契约见 extension-contract.js 的 BROWSE_CACHE_FIELDS）。
   * 纯数据层：不写 chrome.storage、不碰 DOM，写入时机由调用方决定。
   * @param {(path: string) => Promise<object>} apiFetch 统一 API 客户端（调用参数与既有调用点一致：仅 path）
   * @param {{minutes?: number|string}} [options] browseCacheMinutes 原始配置值（0 = 不缓存；非法值回退默认）
   * @returns {Promise<{kind: 'full', fetchedAt: number, ttlMinutes: number, items: Array<object>, total: number, categories: Array<{name: string, level: number}>}>}
   */
  async function fetchFullBrowseCache(apiFetch, { minutes } = {}) {
    const [listResult, catsResult] = await Promise.all([
      apiFetch('/api/config?all=1'),
      apiFetch('/api/categories/tree'),
    ]);
    // listResult.data 为全量书签数组；total 兜底链：缺失取长度 → Number 失败再回长度
    const data = listResult && listResult.data;
    const items = Array.isArray(data) ? data : [];
    const total = Number(listResult.total != null ? listResult.total : items.length) || items.length;
    // 分类树展平为 [{ name, level }]
    const tree = Array.isArray(catsResult && catsResult.data) ? catsResult.data : [];
    const categories = flattenCategoryTree(tree);
    const normalized = Number(minutes);
    const ttlMinutes = Number.isFinite(normalized) && normalized >= 0 ? normalized : contractDefaultCacheMinutes();

    const cache = { kind: 'full', fetchedAt: Date.now(), ttlMinutes, items, total, categories };
    if (!isFullBrowseCache(cache)) {
      throw new Error('全量缓存构建结果未通过 isFullBrowseCache 形状守卫');
    }
    return cache;
  }

  /**
   * 客户端过滤全量书签（仅对 kind==='full' 缓存生效；非 full 不得对部分数据过滤）。
   * @param {Array<object>} items 全量书签
   * @param {{keyword: string, catelog: string, sort: string}} view 当前视图
   * @param {Set<string>|null} catelogNames 当前分类及其全部子孙名集合（null = 不过滤分类）
   * @returns {Array<object>} 过滤 + 排序后的全量结果（未分页）
   */
  function filterBrowseItems(items, view, catelogNames) {
    const kw = String(view.keyword || '').trim().toLowerCase();
    let result = items;
    if (kw) {
      result = result.filter((s) =>
        String(s.name || '').toLowerCase().includes(kw)
        || String(s.url || '').toLowerCase().includes(kw)
        || String(s.catelog || '').toLowerCase().includes(kw)
      );
    }
    if (view.catelog && catelogNames) {
      result = result.filter((s) => catelogNames.has(s.catelog));
    }
    if (view.sort === 'hits') {
      result = [...result].sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0));
    } else if (view.sort === 'last_visit') {
      result = [...result].sort((a, b) =>
        String(b.last_visit_time || b.create_time || '').localeCompare(String(a.last_visit_time || a.create_time || ''))
      );
    } else if (view.sort === 'name') {
      result = [...result].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }
    return result;
  }

  /**
   * 客户端分页切片。
   * @param {Array<object>} items 过滤排序后的结果
   * @param {number} page 从 1 开始
   * @param {number} [pageSize=30]
   * @returns {Array<object>}
   */
  function paginateItems(items, page, pageSize) {
    const size = Math.max(1, Number(pageSize) || 30);
    const start = (Math.max(1, Number(page) || 1) - 1) * size;
    return items.slice(start, start + size);
  }

  /**
   * 是否还有更多页可加载（page 从 1 起，已渲染 = page * pageSize）。
   * @param {number} page
   * @param {number} pageSize
   * @param {number} total 过滤后总条数
   * @returns {boolean}
   */
  function browseHasMore(page, pageSize, total) {
    const size = Math.max(1, Number(pageSize) || 30);
    const current = Math.max(1, Number(page) || 1) * size;
    return current < Number(total);
  }

  /**
   * 手风琴展开切换：同一时间只展开一个父分类；点当前展开的则收起。
   * @param {Set<string>} expanded 当前展开集合（不修改，返回新 Set）
   * @param {string} name 被点 ▸/▾ 的分类名
   * @returns {Set<string>}
   */
  function toggleCategory(expanded, name) {
    const next = new Set();
    if (expanded && expanded.has(name)) {
      // 收起：回到仅顶层
      return next;
    }
    next.add(name);
    return next;
  }

  /**
   * 祖先链注入（renderCategories 渲染前）：筛选分类是子分类且用户没有
   * 手动展开任何父分类时，展开其祖先链保证当前筛选按钮可见。
   * @param {Set<string>} expanded
   * @param {string} catelog 当前筛选分类（可能为空）
   * @param {Array<{name: string, level: number}>} flat 扁平分类列表（含 '' 全部节点）
   * @returns {Set<string>} 新集合
   */
  function injectAncestors(expanded, catelog, flat) {
    const next = new Set(expanded || []);
    if (catelog && next.size === 0) {
      for (const name of ancestorsOf(flat, catelog)) next.add(name);
    }
    return next;
  }

  // 收集 flat 列表中某分类的全部祖先名（用于自动展开）
  function ancestorsOf(flat, name) {
    const idx = flat.findIndex((c) => c.name === name);
    if (idx < 0) return [];
    const out = [];
    let level = flat[idx].level;
    for (let j = idx - 1; j >= 0; j -= 1) {
      if (flat[j].level < level) {
        out.push(flat[j].name);
        level = flat[j].level;
        if (level === 0) break;
      }
    }
    return out;
  }

  // 展平分类树为 [{ name, level }]（跳过空名；子分类 level+1）
  function flattenCategoryTree(nodes, level, out) {
    const acc = out || [];
    for (const node of nodes || []) {
      if (!node || !String(node.name || '').trim()) continue;
      acc.push({ name: String(node.name).trim(), level: level || 0 });
      if (Array.isArray(node.children) && node.children.length) {
        flattenCategoryTree(node.children, (level || 0) + 1, acc);
      }
    }
    return acc;
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

  // 扁平 [{name, level}] 构建树（用栈：level n 挂到最近的 level n-1 节点下）
  function buildCategoryTree(flat) {
    const root = [];
    const stack = [{ name: '', level: -1, children: root }];
    for (const c of flat || []) {
      while (stack.length && stack[stack.length - 1].level >= c.level) stack.pop();
      const node = { name: c.name, level: c.level, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
    }
    return root;
  }

  /**
   * 收集展开节点的子分类，按父分类分组（数据层，不含 HTML）。
   * @param {Array} tree buildCategoryTree 的结果
   * @param {Set<string>} expanded
   * @param {string} activeName 当前筛选分类
   * @returns {Array<{name: string, items: Array<{name: string, level: number, hasChildren: boolean, expanded: boolean, active: boolean}>}>}
   */
  function collectCategoryGroups(tree, expanded, activeName) {
    const groups = [];
    for (const node of tree || []) {
      if (!node.children.length || !expanded.has(node.name)) continue;
      const items = [];
      for (const child of node.children) collectChildItems(child, items, 0, expanded, activeName);
      groups.push({ name: node.name, items });
    }
    return groups;
  }

  function collectChildItems(child, out, level, expanded, activeName) {
    const hasChildren = child.children.length > 0;
    const isExpanded = hasChildren && expanded.has(child.name);
    out.push({
      name: child.name,
      level,
      hasChildren,
      expanded: isExpanded,
      active: activeName === child.name,
    });
    if (isExpanded) {
      for (const grand of child.children) collectChildItems(grand, out, level + 1, expanded, activeName);
    }
  }

  // ── 浏览视图状态（viewState 纯函数组）────────────────────────────
  // 视图状态 = { catelog, keyword, sort, page }；popup.js 持有状态对象，
  // 每次变更经纯 transition 返回新状态再渲染（IO/副作用句柄留 DOM 层）。

  function defaultBrowseView() {
    return { catelog: '', keyword: '', sort: '', page: 1 };
  }

  /**
   * 筛选/搜索/排序变更：只改传入字段，其余保持，页码重置为 1。
   * @param {{catelog?: string, keyword?: string, sort?: string, page?: number}} view
   * @param {{catelog?: string, keyword?: string, sort?: string}} next 传入的字段生效，缺省保持
   */
  function applyBrowseFilter(view, next) {
    return {
      catelog: String(next.catelog ?? view.catelog ?? ''),
      keyword: String(next.keyword ?? view.keyword ?? ''),
      sort: String(next.sort ?? view.sort ?? ''),
      page: 1,
    };
  }

  /** 分页转移：页码下限 1。 */
  function applyBrowsePage(view, page) {
    return { ...view, page: Math.max(1, Number(page) || 1) };
  }

  /**
   * 视图持久化反序列化：非法输入回退 null（调用方保持默认视图）。
   * 字段按既有语义 String 强转。序列化形状由 DOM 层持有（源码锁约束，
   * 见 tests/popup-view-mount.test.js 的浏览视图冒烟：catelog/keyword/sort + ts）。
   * @param {string|null} raw localStorage 原文
   */
  function deserializeView(raw) {
    try {
      const saved = JSON.parse(raw || 'null');
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
      return {
        catelog: String(saved.catelog || ''),
        keyword: String(saved.keyword || ''),
        sort: String(saved.sort || ''),
      };
    } catch {
      return null;
    }
  }

  /**
   * 手风琴切换 + 注入抑制：展开/收起规则（toggleCategory）+「手动收起后
   * 本次会话不再自动注入祖先链」标志，同处一地。
   * @param {{expanded: Set<string>}} state
   * @param {string} name 点击的父分类名
   * @returns {{expanded: Set<string>, suppressAncestorInjection: boolean}}
   */
  function toggleCategoryInState(state, name) {
    const hadExpansion = state.expanded.size > 0;
    const expanded = toggleCategory(state.expanded, name);
    const suppressAncestorInjection = hadExpansion && expanded.size === 0;
    return { expanded, suppressAncestorInjection };
  }

  /**
   * 收起父分类时若筛选在其子孙下，筛选改指父分类（显示父+子孙全部）。
   * 仅在手动收起（suppressAncestorInjection 为真）时由调用方判定调用。
   * @param {{catelog?: string, page?: number}} view
   * @param {string} collapsedName 被收起的父分类名
   * @param {Array<{name: string, level: number}>} flat 展平分类列表
   * @returns {object|null} 变化后的视图（catelog 改指 + page 重置），未变化返回 null
   */
  function collapseChangedFilter(view, collapsedName, flat) {
    const current = String(view.catelog || '');
    if (current && current !== collapsedName && collectCategoryNames(flat, collapsedName).has(current)) {
      return { ...view, catelog: collapsedName, page: 1 };
    }
    return null;
  }

  /** 收集分类及其全部子孙名（父分类筛选含子孙书签）。 */
  function collectCategoryNames(flat, name) {
    const set = new Set();
    const tree = buildCategoryTree([{ name: '', level: 0 }, ...flat]);
    const walk = (nodes) => {
      for (const node of nodes) {
        if (node.name === name) {
          collectSubtree(node, set);
          return true;
        }
        if (walk(node.children)) return true;
      }
      return false;
    };
    walk(tree);
    return set;
  }

  function collectSubtree(node, set) {
    set.add(node.name);
    for (const child of node.children) collectSubtree(child, set);
  }

  const BrowseLogic = {
    isFullBrowseCache,
    isBrowseCacheFresh,
    decideBrowseView,
    fetchFullBrowseCache,
    filterBrowseItems,
    paginateItems,
    browseHasMore,
    toggleCategory,
    injectAncestors,
    ancestorsOf,
    flattenCategoryTree,
    normalizeCategories,
    buildCategoryTree,
    collectCategoryGroups,
    defaultBrowseView,
    applyBrowseFilter,
    applyBrowsePage,
    deserializeView,
    toggleCategoryInState,
    collapseChangedFilter,
    collectCategoryNames,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrowseLogic;
  } else {
    global.BrowseLogic = BrowseLogic;
  }
})(typeof self !== 'undefined' ? self : globalThis);
