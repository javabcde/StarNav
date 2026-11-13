// 插件地址栏搜索纯逻辑：收藏匹配排序、建议描述构建、输入目标判定。
// 不碰 DOM / chrome API，可被 node:test 直接测试（tests/omnibox-logic.test.js）。
// 以 UMD 挂载：浏览器经典 script 下挂 globalThis.OmniboxLogic，node 下走 module.exports。
// 依赖全局 Contract.escapeHTML（background.js 经 importScripts 先加载 extension-contract.js）。
(function (global) {
  'use strict';

  // 地址栏建议条数上限（Chrome 会截断显示区域，8 条足够覆盖一屏）
  const MAX_SUGGESTIONS = 8;
  const NAME_DISPLAY_MAX = 60;
  const URL_DISPLAY_MAX = 100;
  const META_DISPLAY_MAX = 50;

  // 建议描述是 XML：用户数据先转义，再插入 <match>/<url>/<dim> 标记。
  function escapeXml(value) {
    const contract = global.Contract;
    if (!contract || typeof contract.escapeHTML !== 'function') {
      throw new Error('omnibox-logic 依赖全局 Contract：extension-contract.js 须先于 omnibox-logic.js 加载');
    }
    return contract.escapeHTML(value);
  }

  function normalizeQuery(text) {
    return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  }

  // 只允许 http(s)：站点数据可能被污染，不能让 javascript:/data: 进入地址栏导航
  function isSafeNavUrl(url) {
    return /^https?:\/\//i.test(String(url || '').trim());
  }

  function tagNames(item) {
    const raw = item && Array.isArray(item.tags) ? item.tags : [];
    return raw
      .map((tag) => (tag && typeof tag === 'object' ? tag.name || tag.tag || '' : tag))
      .map((tag) => String(tag || '').trim())
      .filter(Boolean);
  }

  // 截断长文本（保留尾部）：名称/元信息用
  function truncateTail(value, max) {
    const text = String(value || '');
    if (text.length <= max) return text;
    return `${text.slice(0, Math.max(1, max - 1))}…`;
  }

  // 截断长 URL（保留头尾）：域名与路径尾部都比中间更有辨识度
  function truncateMiddle(value, max) {
    const text = String(value || '');
    if (text.length <= max) return text;
    const head = Math.ceil((max - 1) / 2);
    const tail = Math.floor((max - 1) / 2);
    return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
  }

  /**
   * 单条匹配分：先判多词全命中，再按命中字段加权。
   * 名称精确 > 名称前缀 > 名称包含 > URL > 分类 > 标签；
   * 多词逐词出现在名称/分类/标签时再给小额加分，提升「react hooks」这类输入。
   */
  function scoreItem(item, query, tokens) {
    const name = String(item.name || '').toLowerCase();
    const url = String(item.url || '').toLowerCase();
    const catelog = String(item.catelog || '').toLowerCase();
    const tags = tagNames(item).map((tag) => tag.toLowerCase());
    const haystack = [name, url, catelog, ...tags].join('\n');
    if (!tokens.every((token) => haystack.includes(token))) return 0;

    let score = 1;
    if (name === query) score = 1000;
    else if (name.startsWith(query)) score = 700;
    else if (name.includes(query)) score = 500;
    else if (url.includes(query)) score = 300;
    else if (catelog.includes(query)) score = 150;
    else if (tags.some((tag) => tag.includes(query))) score = 120;

    for (const token of tokens) {
      if (name.startsWith(token)) score += 12;
      else if (name.includes(token)) score += 8;
      else if (catelog.includes(token)) score += 3;
      else if (tags.some((tag) => tag.includes(token))) score += 2;
    }
    return score;
  }

  /**
   * 地址栏匹配：对全量缓存 items 做本地过滤排序。
   * - 关键词按空白拆词，所有词都必须命中（名称/URL/分类/标签任一字段）
   * - 大小写不敏感；同 URL 去重；只保留 http(s)
   * - 排序：匹配分 → hits → 名称
   * @param {Array<object>} items
   * @param {string} text 地址栏输入
   * @param {number} [limit=8]
   * @returns {Array<object>} 匹配的书签（最多 limit 条）
   */
  function searchOmniboxItems(items, text, limit) {
    const query = normalizeQuery(text).toLowerCase();
    if (!query) return [];
    const max = Math.max(1, Math.min(Number(limit) || MAX_SUGGESTIONS, 20));
    const tokens = query.split(' ');
    const ranked = [];

    for (const item of Array.isArray(items) ? items : []) {
      if (!item || !isSafeNavUrl(item.url)) continue;
      const score = scoreItem(item, query, tokens);
      if (!score) continue;
      ranked.push({ item, score });
    }

    ranked.sort((a, b) => (
      b.score - a.score
      || (Number(b.item.hits) || 0) - (Number(a.item.hits) || 0)
      || String(a.item.name || '').localeCompare(String(b.item.name || ''))
    ));

    const result = [];
    const seen = new Set();
    for (const { item } of ranked) {
      const url = String(item.url).trim();
      if (seen.has(url)) continue;
      seen.add(url);
      result.push(item);
      if (result.length >= max) break;
    }
    return result;
  }

  // 在名称里标出完整关键词命中段（大小写不敏感），结果已做 XML 转义
  function markMatches(text, query) {
    const source = String(text || '');
    const phrase = normalizeQuery(query);
    if (!phrase) return escapeXml(source);
    const lowerSource = source.toLowerCase();
    const lowerPhrase = phrase.toLowerCase();
    let out = '';
    let index = 0;
    for (;;) {
      const at = lowerSource.indexOf(lowerPhrase, index);
      if (at < 0) {
        out += escapeXml(source.slice(index));
        break;
      }
      out += escapeXml(source.slice(index, at));
      out += `<match>${escapeXml(source.slice(at, at + phrase.length))}</match>`;
      index = at + phrase.length;
    }
    return out;
  }

  // 单条建议描述：名称（关键词高亮） + URL（灰显） + 分类/标签（暗色）
  function omniboxDescription(item, query) {
    const name = String(item.name || item.url || '未命名');
    const url = String(item.url || '');
    const meta = [String(item.catelog || '').trim(), ...tagNames(item).slice(0, 3)]
      .filter(Boolean)
      .join(' · ');
    const nameHtml = markMatches(truncateTail(name, NAME_DISPLAY_MAX), query);
    const urlHtml = escapeXml(truncateMiddle(url, URL_DISPLAY_MAX));
    const metaHtml = meta ? ` <dim>${escapeXml(truncateTail(meta, META_DISPLAY_MAX))}</dim>` : '';
    return `${nameHtml} — <url>${urlHtml}</url>${metaHtml}`;
  }

  /**
   * 构建 chrome.omnibox 建议数组：content 为最终导航 URL（onInputEntered 原样收到）。
   * @param {Array<object>} items
   * @param {string} query
   * @returns {Array<{content: string, description: string}>}
   */
  function buildOmniboxSuggestions(items, query) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && isSafeNavUrl(item.url))
      .map((item) => ({
        content: String(item.url).trim(),
        description: omniboxDescription(item, query),
      }));
  }

  // 域名形态（含可选端口与路径）：example.com、sub.example.com/path?x=1
  const DOMAIN_LIKE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#][^\s]*)?$/i;

  /**
   * 判定回车目标：完整 http(s) URL 原样导航；裸域名补 https://；其余按关键词搜索。
   * 非 http(s) scheme（javascript:/data: 等）一律按关键词处理，不进入导航。
   * @param {string} text
   * @returns {{kind: 'url', url: string}|{kind: 'search', value: string}}
   */
  function normalizeOmniboxTarget(text) {
    const raw = String(text || '').trim();
    if (!raw) return { kind: 'search', value: '' };
    if (isSafeNavUrl(raw)) return { kind: 'url', url: raw };
    if (DOMAIN_LIKE.test(raw)) return { kind: 'url', url: `https://${raw}` };
    return { kind: 'search', value: raw };
  }

  /**
   * 默认建议文案（未选中任何候选时地址栏第一行）：
   * 未配置 / 空输入提示 / 命中数 / 无匹配回车回首页 / 缓存加载中。
   * 返回值已做 XML 转义。
   */
  function renderDefaultSuggestion({ query = '', configured = true, total = 0, matched = 0, loading = false } = {}) {
    const keyword = normalizeQuery(query);
    if (!configured) return escapeXml('请先在插件选项中配置 StarNav 地址与 Token');
    if (!keyword) {
      const suffix = Number(total) > 0 ? `（共 ${Number(total)} 条）` : '';
      return escapeXml(`输入关键词搜索 StarNav 收藏${suffix}`);
    }
    if (loading) return escapeXml(`正在加载收藏缓存…「${keyword}」`);
    if (Number(matched) > 0) return escapeXml(`在 StarNav 收藏中搜索「${keyword}」`);
    return escapeXml(`没有匹配「${keyword}」的收藏，回车打开 StarNav 首页`);
  }

  const OmniboxLogic = {
    MAX_SUGGESTIONS,
    isSafeNavUrl,
    searchOmniboxItems,
    buildOmniboxSuggestions,
    normalizeOmniboxTarget,
    renderDefaultSuggestion,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = OmniboxLogic;
  } else {
    global.OmniboxLogic = OmniboxLogic;
  }
})(typeof self !== 'undefined' ? self : globalThis);
