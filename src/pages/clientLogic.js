// 页面客户端纯逻辑（client logic）：首页与后台客户端脚本的共享纯函数。
// 经 toString() 生成期内联进模板（clientScript.js String.raw / adminJs 模板），node:test 直接单测。
// 内联约束（见 clientScript.js 模块加载探针）：函数体禁止反引号与 ${ 序列；
// 禁止引用模块级状态——被内联后失去闭包，只能引用参数与同文件内联的兄弟函数。
// 2026-08-16 架构评审候选 2：收编首页 escapeText/normalizeClientUrl/normalizeAiText 与
// 后台 escapeHTML/normalizeUrl 的逐份副本（URL 归一此前三份、转义两份）。
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
