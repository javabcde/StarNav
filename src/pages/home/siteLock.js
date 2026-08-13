import { escapeHTML, htmlResponse } from '../../lib/utils.js';

/**
 * 整站锁全屏密码页。复用 renderPrivateBookmarkPasswordPage 的渲染模式
 * （Tailwind CDN 全屏居中卡片），未解锁访客访问任何被挡路由时展示。
 *
 * 无错误时该页对所有匿名访客一致，可被边缘缓存（s-maxage=60，与首页缓存一致）；
 * 带错误（密码错/限速）时不加缓存头，避免把错误态缓存给后续访客。
 *
 * @param {object} options
 * @param {string} [options.next] 解锁成功后回跳的同源路径（以 / 开头）。
 * @param {string} [options.error] 错误提示文案（已本地化）。
 * @param {object} [options.i18n] resolveI18n(request) 的返回值。
 */
export function renderSiteLockPage({ next = '', error = '', i18n } = {}) {
  const fallbackI18n = i18n || { lang: 'zh-CN', dir: 'ltr', th: (key) => key };
  const { lang, dir, th } = fallbackI18n;
  const safeNext = String(next || '').startsWith('/') && !String(next).startsWith('//') ? String(next) : '/';

  const response = htmlResponse(`<!DOCTYPE html>
<html lang="${escapeHTML(lang)}" dir="${escapeHTML(dir)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${th('siteLockTitle')} - ${th('appName')}</title>
  <script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="min-h-screen bg-slate-50 text-gray-800 flex items-center justify-center px-4">
  <div class="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-xl">
    <div class="text-center">
      <div class="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-2xl">🔒</div>
      <h1 class="text-2xl font-semibold text-slate-900">${th('siteLockTitle')}</h1>
      <p class="mt-3 text-sm text-slate-600">${th('siteLockDesc')}</p>
    </div>
    ${error ? `<div class="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">${escapeHTML(error)}</div>` : ''}
    <form method="post" action="/?next=${encodeURIComponent(safeNext)}" class="mt-6 space-y-4">
      <input type="hidden" name="next" value="${escapeHTML(safeNext)}">
      <input name="password" type="password" required autofocus autocomplete="current-password" placeholder="${th('siteLockEnter')}" class="w-full rounded-lg border border-slate-200 px-4 py-3 outline-none focus:border-slate-400">
      <label class="block text-left text-xs text-slate-600">
        <span class="mb-1 block">${th('siteLockRemember')}</span>
        <select name="duration" class="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-slate-400">
          <option value="session">仅本次会话（关闭浏览器后失效）</option>
          <option value="1h">1 小时</option>
          <option value="12h" selected>12 小时</option>
          <option value="7d">7 天</option>
          <option value="30d">30 天</option>
        </select>
      </label>
      <button type="submit" class="w-full rounded-lg bg-slate-800 px-4 py-3 font-medium text-white hover:bg-slate-900">${th('siteLockUnlock')}</button>
    </form>
  </div>
</body>
</html>`);

  if (!error) {
    // s-maxage 供 CDN 复用；must-revalidate 防止移动浏览器（如夸克）展示失效的旧锁页
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=60');
  }
  return response;
}
