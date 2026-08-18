// 收藏小窗纯逻辑层：分类候选过滤、默认选中解析、回退归一、候选形状守卫。
// 不碰 DOM / chrome API，可被 node:test 直接测试（tests/collect-picker-logic.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.PickerLogic，node 下走 module.exports。
(function (global) {
  'use strict';

  const UNCATEGORIZED = '未分类';

  /**
   * 过滤掉不可作为保存目标的虚拟节点：flattenCategoryTree 会产出
   * 「直属书签」聚合节点（direct: true，ADR-0013 虚拟节点，不建真实分类行）。
   * 真实分类节点保留（name/level；子分类 level 1 缩进渲染）。
   * @param {Array<{name: string, level: number, direct?: boolean}>} flat
   * @returns {Array<{name: string, level: number}>}
   */
  function pickRelevantCategories(flat) {
    return (Array.isArray(flat) ? flat : [])
      .filter((node) => node && !node.direct && String(node.name || '').trim())
      .map((node) => ({ name: String(node.name).trim(), level: Number(node.level) || 0 }));
  }

  /**
   * 默认选中解析链：上次记忆（仍在该次分类列表中）→ options 默认分类（仍在列表）
   * → 「未分类」兜底。记忆/配置值失效（服务端删了分类）时不静默选中脏值。
   * @param {{remembered?: string, configured?: string, available: Array<string>}} opts
   * @returns {string}
   */
  function resolveDefaultCategory({ remembered = '', configured = '', available = [] } = {}) {
    const names = (Array.isArray(available) ? available : []).map((n) => String(n || '').trim()).filter(Boolean);
    const has = (v) => names.includes(String(v || '').trim());
    if (remembered && has(remembered)) return String(remembered).trim();
    if (configured && has(configured)) return String(configured).trim();
    return UNCATEGORIZED;
  }

  /**
   * options「刷新分类/标签缓存」写入 storage.local.categories 的元素形态：
   * 字符串或 { name } 对象（renderDatalist 的取值面）。统一归一为 level 0 平铺列表。
   * @param {Array<string|{name?: string}>} items
   * @returns {Array<{name: string, level: number}>}
   */
  function normalizeFallbackCategories(items) {
    return (Array.isArray(items) ? items : [])
      .map((item) => (typeof item === 'string' ? item : (item && item.name) || ''))
      .map((name) => String(name || '').trim())
      .filter(Boolean)
      .map((name) => ({ name, level: 0 }));
  }

  /**
   * 收藏候选形状守卫：background 写入 { url, name, ts }；缺失/形状不符
   * 时小窗显示「未找到待收藏内容」而不是渲染空表单。
   * @param {unknown} value
   * @returns {boolean}
   */
  function isCollectCandidate(value) {
    return Boolean(value && typeof value === 'object' && String(value.url || '').trim() && String(value.name || '').trim());
  }

  const PickerLogic = {
    UNCATEGORIZED,
    pickRelevantCategories,
    resolveDefaultCategory,
    normalizeFallbackCategories,
    isCollectCandidate,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PickerLogic;
  } else {
    global.PickerLogic = PickerLogic;
  }
})(typeof self !== 'undefined' ? self : globalThis);
