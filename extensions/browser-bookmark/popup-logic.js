// 插件纯逻辑层：浏览缓存决策、分类树/分组、手风琴状态机。
// 不碰 DOM / chrome API，可被 node:test 直接测试（tests/popup-logic.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.BrowseLogic，node 下走 module.exports。
(function (global) {
  'use strict';

  // 缓存签名：不含 page（缓存代表第一页视图，page 单独恢复）
  function browseSignature(view) {
    return [view.keyword, view.catelog, view.sort].join('|');
  }

  // 缓存是否新鲜：minutes <= 0 视为不缓存（总是拉取）
  function isBrowseCacheFresh(cache, minutes, now) {
    if (!cache || !Number.isFinite(minutes) || minutes <= 0) return false;
    return (now || Date.now()) - (cache.fetchedAt || 0) < minutes * 60 * 1000;
  }

  /**
   * 打开浏览视图的决策矩阵（f731227 起的行为契约）：
   * - render：有缓存（fetchedAt 存在）即渲染，无缓存 false（走骨架屏拉取）
   * - refresh：签名不同（换视图）或缓存过期 → 后台静默拉取当前视图替换
   * @param {{fetchedAt?: number, signature?: string}|null} cache
   * @param {{keyword: string, catelog: string, sort: string}} view
   * @param {number} minutes 缓存 TTL 分钟数
   * @param {number} [now]
   * @returns {{render: boolean, refresh: boolean}}
   */
  function decideBrowseView(cache, view, minutes, now) {
    if (!cache || !cache.fetchedAt) return { render: false, refresh: false };
    return {
      render: true,
      refresh: cache.signature !== browseSignature(view) || !isBrowseCacheFresh(cache, minutes, now),
    };
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
    browseSignature,
    isBrowseCacheFresh,
    decideBrowseView,
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
