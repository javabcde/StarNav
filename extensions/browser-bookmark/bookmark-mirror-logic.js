// 浏览器书签镜像纯逻辑：把 StarNav 全量缓存映射成 Chrome 书签文件夹内容。
// 存在原因：扩展 omnibox 必须带关键字，无法在默认地址栏注入建议；把收藏镜像到
// 浏览器书签后，Chrome 原生书签联想无需任何前缀即可命中 StarNav 收藏。
// 不碰 chrome API / DOM，可被 node:test 直接测试（tests/bookmark-mirror-logic.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.BookmarkMirrorLogic，node 下走 module.exports。
(function (global) {
  'use strict';

  // 镜像文件夹位置与名称：其他书签/StarNav 收藏（用户可见，由插件独占管理）
  const MIRROR_FOLDER_TITLE = 'StarNav 收藏';
  const PRIVATE_BOOKMARK_CATEGORY = '私人书签';
  // 私人/管理员专属书签不进入浏览器书签：Chrome 可能同步到云端或被同机其他用户看到
  const HIDDEN_VISIBILITIES = new Set(['private', 'admin_only']);
  const OTHER_BOOKMARKS_TITLES = new Set(['其他书签', 'Other Bookmarks', 'Other bookmarks']);

  function isSafeHttpUrl(url) {
    return /^https?:\/\//i.test(String(url || '').trim());
  }

  // Chrome 会把根路径书签存成 `https://host/`（多一个尾斜杠）。
  // 仅根路径归一化，避免每次镜像把「同一 URL」当成删除+新建；非根路径用 href 对齐 Chrome 规范化。
  function mirrorUrlKey(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
        return `${parsed.protocol}//${parsed.host}`;
      }
      // 非根路径用 href：与 Chrome 的 host 小写、空格转义等规范化形态更接近
      return parsed.href;
    } catch { /* 非法 URL 原样比较 */ }
    return raw;
  }

  function isMirrorableSite(site) {
    if (!site || !isSafeHttpUrl(site.url)) return false;
    const visibility = String(site.visibility || 'public').trim().toLowerCase();
    if (HIDDEN_VISIBILITIES.has(visibility)) return false;
    // 兼容旧数据：私人书签分类可能存在 visibility 未落库的情况
    if (String(site.catelog || '').trim() === PRIVATE_BOOKMARK_CATEGORY) return false;
    return true;
  }

  /**
   * 全量缓存 items → 目标书签列表（标题 + URL）。
   * 同 URL 去重（保留第一条）；标题缺失回退 URL。
   * @param {Array<object>} items
   * @returns {Array<{title: string, url: string}>}
   */
  function desiredMirrorBookmarks(items) {
    const result = [];
    const seen = new Set();
    for (const site of Array.isArray(items) ? items : []) {
      if (!isMirrorableSite(site)) continue;
      const url = String(site.url).trim();
      const key = mirrorUrlKey(url);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push({ title: String(site.name || '').trim() || url, url });
    }
    return result;
  }

  /**
   * 对比镜像文件夹现有子节点与目标列表，算出增量动作。
   * - 现有/目标按归一化 URL 配对；重复 URL 只保留一个，其余删除
   * - 文件夹节点（无 url）不参与：不删除用户自建子文件夹
   * - 目标重复 URL 只保留第一条
   * @param {Array<{id: string, title?: string, url?: string}>} existing
   * @param {Array<{title: string, url: string}>} desired
   * @returns {{create: Array<{title: string, url: string}>, update: Array<{id: string, title: string, url: string}>, remove: string[]}}
   */
  function planBookmarkMirror(existing, desired) {
    const existingByUrl = new Map();
    const remove = [];
    for (const node of Array.isArray(existing) ? existing : []) {
      if (!node || !node.url) continue;
      const key = mirrorUrlKey(node.url);
      if (!key) continue;
      if (existingByUrl.has(key)) {
        remove.push(node.id);
        continue;
      }
      existingByUrl.set(key, { id: node.id, title: String(node.title || '') });
    }

    const create = [];
    const update = [];
    const desiredUrls = new Set();
    for (const item of Array.isArray(desired) ? desired : []) {
      const url = String(item && item.url || '').trim();
      const key = mirrorUrlKey(url);
      if (!key || desiredUrls.has(key)) continue;
      desiredUrls.add(key);
      const title = String(item.title || '').trim() || url;
      const current = existingByUrl.get(key);
      if (!current) {
        create.push({ title, url });
      } else if (current.title !== title) {
        update.push({ id: current.id, title, url });
      }
    }

    for (const [key, node] of existingByUrl) {
      if (!desiredUrls.has(key)) remove.push(node.id);
    }
    return { create, update, remove };
  }

  /**
   * 定位「其他书签」根节点：优先按标题（中英文），兜底 Chrome 家族惯例 id '2'，
   * 再兜底第一个根文件夹。
   * @param {Array<{id: string, title?: string, children?: Array}>} tree chrome.bookmarks.getTree() 结果
   * @returns {string}
   */
  function pickOtherBookmarksRootId(tree) {
    const root = Array.isArray(tree) ? tree[0] : null;
    const roots = root && Array.isArray(root.children) ? root.children : [];
    const named = roots.find((node) => node && !node.url && OTHER_BOOKMARKS_TITLES.has(String(node.title || '').trim()));
    if (named) return named.id;
    const byId = roots.find((node) => node && node.id === '2');
    if (byId) return byId.id;
    const firstFolder = roots.find((node) => node && !node.url);
    return firstFolder ? firstFolder.id : '2';
  }

  const BookmarkMirrorLogic = {
    MIRROR_FOLDER_TITLE,
    PRIVATE_BOOKMARK_CATEGORY,
    isSafeHttpUrl,
    mirrorUrlKey,
    isMirrorableSite,
    desiredMirrorBookmarks,
    planBookmarkMirror,
    pickOtherBookmarksRootId,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = BookmarkMirrorLogic;
  } else {
    global.BookmarkMirrorLogic = BookmarkMirrorLogic;
  }
})(typeof self !== 'undefined' ? self : globalThis);
