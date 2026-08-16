// 页面客户端纯逻辑（client logic）：首页与后台客户端脚本的共享纯函数。
// 经 toString() 生成期内联进模板（clientScript.js String.raw / adminJs 模板），node:test 直接单测。
// 内联约束（见 clientScript.js 模块加载探针）：函数体禁止反引号与 ${ 序列；
// 函数体引用的自由符号（escapeText、weekdayNames）必须在模板作用域同名存在——
// 模板侧负责一并内联或定义（adminJs 另设 const escapeText=escapeHTML 别名）。
// 禁止函数体引用 escapeHTML 别名：wrangler 打包（esbuild）与 lib/utils.js 的 escapeHTML
// 导出合并作用域后必然重命名其一（实测别名被改名 escapeHTML2），toString 内联即 ReferenceError。
// 2026-08-16 架构评审候选 2：收编首页 escapeText/normalizeClientUrl/normalizeAiText 与
// 后台 escapeHTML/normalizeUrl 及分析/同步/备份/Token 簇的逐份副本。
export function escapeText(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 客户端 URL 归一：裸域名补 https，无法识别返回空串。与后台 normalizeUrl 同源（内联同名）。
export function normalizeClientUrl(v) {
  const t = String(v || '').trim();
  return /^https?:\/\//i.test(t) ? t : (/^[\w.-]+\.[\w.-]+/.test(t) ? 'https://' + t : '');
}

// 关键词高亮：先转义再包 <mark>；关键词先转义正则特殊字符。
export function highlightText(v, kw) {
  const text = escapeText(v);
  if (!kw) return text;
  const safe = kw.replace(/[-\/\\^*+?.()|[\]{}]/g, '\\$&');
  try {
    return text.replace(new RegExp('(' + safe + ')', 'ig'), '<mark class="rounded bg-amber-100 px-0.5 text-amber-900">$1</mark>');
  } catch {
    return text;
  }
}

// AI 回答文本归一：剥 Markdown 加粗/下划线、列表符转 ·、折叠多空行、去首尾空白。
export function normalizeAiText(text) {
  return String(text || '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// 搜索历史合并：新词置顶、去重、上限 8 条（纯逻辑；读写 localStorage 留在调用方）。
export function mergeSearchHistory(items, term) {
  const next = [term, ...items.filter((item) => item !== term)].slice(0, 8);
  return next;
}

// ── 后台（adminJs 模板）共享纯函数 ─────────────────────────────────────
// 星期名表：模板经 WEEKDAY_NAMES 生成期内联（JSON 字面量），formatPeak 源码
// 引用模板作用域内的 weekdayNames（同名单一源）。
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayNames = WEEKDAY_NAMES;

// 模板内联名统一为 escapeHTML（后台历史调用名）；模块内与 escapeText 同引用。
const escapeHTML = escapeText;

// 提交热力等级：0-4 档（75%/50%/25% 阈值）。
export function heatLevel(value, max) {
  if (!value || !max) return 0;
  const ratio = value / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

// 提交峰值时段文案：'周X HH:00'。
export function formatPeak(peak) {
  if (!peak || peak.weekday === null || !peak.total) return '暂无';
  return weekdayNames[peak.weekday] + ' ' + String(peak.hour).padStart(2, '0') + ':00';
}

// 提交画像五维评分（雷达图数据）：活跃度/稳定性/分类分散/待处理压力/峰值集中。
export function getAnalyticsScores(data) {
  const summary = data.summary || {};
  const daily = data.daily || [];
  const categories = data.categories || [];
  const recent = Number(summary.recentSubmissions || 0);
  const days = Number(data.rangeDays || 30);
  const activeDays = daily.filter((d) => d.total > 0).length;
  const topCategory = categories[0]?.total || 0;
  const diversityBase = recent ? Math.max(0, 100 - (topCategory / recent) * 100) : 0;
  const peakRatio = recent ? Math.min(100, (summary.maxHeat || 0) / recent * 240) : 0;
  return [
    { name: '活跃度', value: Math.min(100, Math.round(recent / Math.max(1, days * 2) * 100)) },
    { name: '稳定性', value: Math.round(activeDays / Math.max(1, days) * 100) },
    { name: '分类分散', value: Math.round(Math.min(100, diversityBase + categories.length * 4)) },
    { name: '待处理压力', value: Math.min(100, Math.round((summary.totalPending || 0) / 20 * 100)) },
    { name: '峰值集中', value: Math.round(peakRatio) },
  ];
}

// 分类主题色取色器归一：仅 #rrggbb 有效，其余回退默认。
export function normalizePickerColor(value) {
  const v = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '#b86b4b';
}

// Token scope 标签渲染（逗号/空白分隔），空列表回退 read 徽章。
export function formatTokenScopes(scopes) {
  return (Array.isArray(scopes) ? scopes : String(scopes || '').split(/[,\s]+/)).filter(Boolean)
    .map((s) => '<span class="tag-pill">' + escapeText(s) + '</span>').join(' ') || '<span class="tag-pill">read</span>';
}

// 同步统计药丸。
export function syncStatPill(label, count, danger = false) {
  const color = danger ? '#963d3d' : '#24211d';
  const border = danger ? '#e0a8a0' : '#e6d9c8';
  return '<span style="display:inline-flex;align-items:center;gap:4px;border:1px solid ' + border + ';border-radius:999px;background:#fffdf8;padding:6px 12px;font-weight:700;color:var(--admin-muted)"><span style="color:var(--admin-muted)">' + label + '</span><strong style="color:' + color + '">' + count + '</strong></span>';
}

// 同步列表摘要 HTML（上限 cap 条，超出追加省略说明）。
export function syncListHtml(items, cap = 50) {
  const list = items || [];
  let html = list.slice(0, cap).map((it) => '<li>' + escapeText(it.name || '未命名') + '（' + escapeText(it.url || '') + '）</li>').join('');
  if (list.length > cap) html += '<li>… 等共 ' + list.length + ' 条</li>';
  return html;
}

// 同步失败清单 HTML（上限 50 条）。
export function syncFailedHtml(items) {
  if (!items || !items.length) return '';
  const list = items || [];
  return '<div class="ai-status error" style="white-space:normal;margin-top:10px"><strong>失败 ' + list.length + ' 条：</strong><ul style="margin:8px 0 0;padding-left:20px;line-height:1.8">' + list.slice(0, 50).map((it) => '<li>' + escapeText(it.url || '（无 URL）') + '：' + escapeText(it.reason || '未知原因') + '</li>').join('') + (list.length > 50 ? '<li>… 等共 ' + list.length + ' 条</li>' : '') + '</ul></div>';
}

// 同步统计条 HTML（新增/更新/删除/跳过/失败五枚药丸）。
export function renderSyncStats(html, stats) {
  html += '<div class="sync-stats" style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:10px">';
  html += syncStatPill('新增', stats.added || 0);
  html += syncStatPill('更新', stats.updated || 0);
  html += syncStatPill('删除', stats.deleted || 0, true);
  html += syncStatPill('跳过', stats.skipped || 0);
  html += syncStatPill('失败', stats.failed || 0, true);
  html += '</div>';
  return html;
}

// 备份体积格式化：B / KB / MB。
export function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(2) + ' MB';
}

// 备份记录 WebDAV 状态后缀文案。
export function webdavStatusText(m) {
  const w = m?.webdav;
  if (!w) return '';
  if (w.uploaded) return '，WebDAV 已上传：' + (w.fileName || '');
  if (w.skipped) return '，WebDAV 未启用';
  if (w.error) return '，WebDAV 上传失败：' + w.error;
  return '';
}

// AI 后台分析归一：no-tags / duplicates / search-gaps / category-errors 四类
// 建议项 → 统一的 { items, total } 展示结构。
export function normalizeAiAdminItems(type, data) {
  const items = [];
  if (type === 'no-tags') {
    const sugMap = new Map();
    (data.suggestions || []).forEach(function (s) { sugMap.set(s.siteId, s.tags || []); });
    (data.sites || []).forEach(function (s) {
      const tags = sugMap.get(s.id);
      items.push({ id: s.id, name: s.name || '', detail: (s.catelog || '未分类') + (s.url ? ' · ' + s.url : ''), suggestion: tags && tags.length ? '推荐标签：' + tags.join('、') : '' });
    });
    return { items: items, total: data.total || 0 };
  }
  if (type === 'duplicates') {
    const sugMap = new Map();
    (data.suggestions || []).forEach(function (s) { sugMap.set(s.domainKey, s); });
    (data.groups || []).forEach(function (g) {
      const sug = sugMap.get(g.domainKey);
      const siteList = g.sites.map(function (s) { return s.name + '(' + s.hits + '次)'; }).join('、');
      items.push({ id: g.sites[0]?.id, name: '域名：' + g.domainKey, detail: g.count + ' 个书签：' + siteList, suggestion: sug ? (sug.isDuplicate ? '建议保留 #' + sug.keepId + (sug.reason ? '，' + sug.reason : '') : 'AI 判断非重复' + (sug.reason ? '：' + sug.reason : '')) : '' });
    });
    return { items: items, total: data.groupCount || 0 };
  }
  if (type === 'search-gaps') {
    const sugMap = new Map();
    (data.suggestions || []).forEach(function (s) { sugMap.set(s.keyword, s.suggestions || []); });
    (data.gaps || []).forEach(function (g) {
      const sug = sugMap.get(g.keyword);
      const sugText = sug && sug.length ? sug.map(function (s) { return s.name + (s.url ? ' (' + s.url + ')' : ''); }).join('；') : '';
      items.push({ name: g.keyword, detail: '搜索 ' + g.totalSearches + ' 次，' + g.zeroResultCount + ' 次无结果', suggestion: sugText ? '建议收录：' + sugText : '' });
    });
    return { items: items, total: data.total || 0 };
  }
  if (type === 'category-errors') {
    (data.orphaned || []).forEach(function (s) {
      items.push({ id: s.id, name: s.name || '', detail: s.issue + (s.catelog ? ' (当前：' + s.catelog + ')' : ' (未设置分类)'), suggestion: '' });
    });
    (data.suggestions || []).forEach(function (s) {
      const existing = items.find(function (i) { return i.id === s.siteId; });
      if (existing) {
        existing.suggestion = '建议改为：' + s.suggestedCategory + (s.reason ? '，' + s.reason : '');
      } else {
        items.push({ id: s.siteId, name: s.siteName || '', detail: '当前分类：' + s.currentCategory, suggestion: '建议改为：' + s.suggestedCategory + (s.reason ? '，' + s.reason : '') });
      }
    });
    return { items: items, total: data.totalOrphaned || items.length };
  }
  return { items: items, total: 0 };
}

// 后台统一 API 客户端：非 JSON 兜底解析、GET 失败静默重试（450ms 间隔，Abort 中断不重试）。
// 引用 fetch/setTimeout 浏览器全局，node 测试 mock globalThis.fetch。
export function apiJson(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const fetchOptions = { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options };
  const parse = async (r) => {
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return { code: r.status, message: text || r.statusText || 'Request failed' };
    }
  };
  const request = () => fetch(url, fetchOptions).then(parse);
  return request().catch((error) => {
    if (error?.name === 'AbortError' || method !== 'GET' || options.signal?.aborted) throw error;
    return new Promise((resolve) => setTimeout(resolve, 450)).then(() => {
      if (options.signal?.aborted) throw error;
      return request();
    });
  });
}
