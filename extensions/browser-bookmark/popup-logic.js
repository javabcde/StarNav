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

  const BrowseLogic = {
    isFullBrowseCache,
    isBrowseCacheFresh,
    decideBrowseView,
    filterBrowseItems,
    paginateItems,
    toggleCategory,
    injectAncestors,
    ancestorsOf,
    flattenCategoryTree,
    normalizeCategories,
    buildCategoryTree,
    collectCategoryGroups,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrowseLogic;
  } else {
    global.BrowseLogic = BrowseLogic;
  }
})(typeof self !== 'undefined' ? self : globalThis);
