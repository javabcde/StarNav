import { escapeHTML, htmlResponse, isSubmissionEnabled, sanitizeImageUrl, sanitizeUrl } from '../lib/utils.js';
import { resolveI18n } from '../lib/i18n.js';
import { getAllSites } from '../services/siteService.js';
import { getAccessContext } from '../services/accessService.js';
import { getCategoryTree } from '../services/categoryService.js';
import { getSystemSettings } from '../services/systemSettingsService.js';
import {
  PRIVATE_BOOKMARK_CATEGORY,
  buildClearPrivateBookmarkAccessCookie,
  buildPrivateBookmarkAccessCookie,
  createPrivateBookmarkAccess,
  isPrivateBookmarkCategory,
  revokeCurrentPrivateBookmarkAccess,
  verifyPrivateBookmarkPassword,
} from '../services/privateBookmarkService.js';

import { renderPrivateBookmarkUnlockBox, renderPrivateBookmarkPasswordPage } from './home/privateAccess.js';
import { flattenCategories, getAncestorNames, renderCategoryLinks } from './home/categories.js';
import { renderSiteCard, renderGroupedSites, renderDashboardSites, sortSitesForView, renderSortLinks } from './home/siteCard.js';
import { renderAnnouncementModal } from './home/announcement.js';
import { renderFrontAdminModal, renderSubmitModal } from './home/modals.js';
import { frontAdminScript, dragScript, myUsageScript } from './home/scripts.js';
import { homeClientScript } from './home/clientScript.js';
import { homeCssVersion } from './home/css.js';

// 收集某分类及其全部子孙分类名（分类树递归，与 API 端递归 CTE 语义一致）
function collectCategoryWithDescendants(nodes, targetName, acc = new Set()) {
  for (const node of nodes) {
    if (node.name === targetName) {
      collectSubtreeNames(node, acc);
      return acc;
    }
    if (Array.isArray(node.children) && node.children.length) {
      collectCategoryWithDescendants(node.children, targetName, acc);
    }
  }
  return acc;
}

function collectSubtreeNames(node, acc) {
  acc.add(node.name);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectSubtreeNames(child, acc);
  }
}

export async function renderHomePage(request, env, ctx) {
  const i18n = resolveI18n(request);
  const { lang, dir, t, th } = i18n;
  const url = new URL(request.url);
  const catalog = (url.searchParams.get('catalog') || '').trim();
  const requestedSort = (url.searchParams.get('sort') || '').trim();
  const sortMode = ['hot', 'recent'].includes(requestedSort) ? requestedSort : '';
  const tagFilter = (url.searchParams.get('tag') || '').trim();
  const isPrivateCatalog = isPrivateBookmarkCategory(catalog);
  const [access, systemSettings] = await Promise.all([
    getAccessContext(request, env),
    getSystemSettings(env),
  ]);
  const adminAuthed = access.adminAuthed;
  // 页面语义：token 不授予私人书签（browserPrivateUnlocked，与迁移前一致）
  const privateUnlocked = access.browserPrivateUnlocked;
  const currentSpaceSlug = '';
  const [visibleSites, categoryTree] = await Promise.all([
    getAllSites(env, { access: { adminAuthed: access.adminAuthed, privateUnlocked: access.browserPrivateUnlocked } }),
    getCategoryTree(env),
  ]);

  if (request.method === 'POST') {
    const clonedRequest = request.clone();
    const formData = await clonedRequest.formData();
    if (formData.get('_action') === 'logout-private') {
      await revokeCurrentPrivateBookmarkAccess(request, env);
      return new Response(null, {
        status: 302,
        headers: {
          Location: '/',
          'Set-Cookie': buildClearPrivateBookmarkAccessCookie(),
        },
      });
    }
  }

  if (isPrivateCatalog && !adminAuthed && request.method === 'POST') {
    const formData = await request.formData();
    const password = formData.get('password') || '';
    const requestedDuration = formData.get('duration') || '12h';
    if (await verifyPrivateBookmarkPassword(env, password)) {
      const { token, ttl, duration } = await createPrivateBookmarkAccess(env, { duration: requestedDuration });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `/?catalog=${encodeURIComponent(PRIVATE_BOOKMARK_CATEGORY)}`,
          'Set-Cookie': buildPrivateBookmarkAccessCookie(token, { maxAge: ttl, duration }),
        },
      });
    }

    return renderPrivateBookmarkPasswordPage({ catalog, error: t('passwordError'), i18n });
  }

  const flatCategories = flattenCategories(categoryTree);
  const categoryNames = flatCategories.map((item) => item.name);
  const datalistCategoryNames = categoryNames.filter((name) => !isPrivateBookmarkCategory(name));
  const catalogExists = Boolean(catalog && categoryNames.includes(catalog));
  const privateCatalogLocked = catalogExists && isPrivateCatalog && !privateUnlocked;
  // 分类过滤含子孙：点父分类显示父 + 全部子分类的书签（与 /api/config 的 getSites 一致）
  const catalogNames = catalogExists
    ? collectCategoryWithDescendants(categoryTree, catalog)
    : new Set();
  if (catalogExists && catalogNames.size === 0) catalogNames.add(catalog); // 兜底精确匹配（旧数据无分类记录）
  const baseCurrentSites = catalogExists
    ? (privateCatalogLocked ? [] : visibleSites.filter((site) => catalogNames.has(site.catelog)))
    : visibleSites;
  const taggedCurrentSites = tagFilter
    ? baseCurrentSites.filter((site) => Array.isArray(site.tags) && site.tags.includes(tagFilter))
    : baseCurrentSites;
  const canDragSort = adminAuthed && !sortMode && !tagFilter && !privateCatalogLocked;
  const currentSites = sortSitesForView(taggedCurrentSites, sortMode);
  const submissionEnabled = isSubmissionEnabled(env, systemSettings);
  const privateBookmarksVisible = systemSettings.privateBookmarksVisible !== 'false';
  const siteName = systemSettings.siteName || th('appName');
  const siteSubtitle = systemSettings.siteSubtitle || th('heroSubtitle');
  const siteIcon = sanitizeImageUrl(systemSettings.siteIcon) || sanitizeUrl(systemSettings.siteIcon) || '/pwa-icon.svg';
  const footerText = systemSettings.footerText || th('footer');
  const pageBackgroundImage = sanitizeImageUrl(systemSettings.backgroundImage) || '';
  const defaultLayout = ['grid', 'list', 'grouped', 'masonry', 'dashboard'].includes(systemSettings.defaultLayout) ? systemSettings.defaultLayout : 'grid';
  const defaultAccent = ['blue', 'green', 'purple', 'rose', 'amber'].includes(systemSettings.defaultAccent) ? systemSettings.defaultAccent : 'blue';
  const heroVisible = systemSettings.heroVisible !== 'false';
  const blogVisible = systemSettings.blogVisible !== 'false';
  const blogUrl = sanitizeUrl(systemSettings.blogUrl) || 'https://blog.110995.xyz/';
  const blogLabel = systemSettings.blogLabel || th('visitBlog');
  const blogLink = blogVisible && blogUrl ? `<a href="${escapeHTML(blogUrl)}" target="_blank" rel="noopener noreferrer" class="mt-4 flex items-center px-4 py-2 text-gray-600 hover:text-primary-500 transition duration-300">
          <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
          </svg>
          ${escapeHTML(blogLabel)}
        </a>` : '';
  const announcement = {
    enabled: systemSettings.announcementEnabled === 'true' && Boolean(systemSettings.announcementMarkdown),
    title: systemSettings.announcementTitle || '系统公告',
    markdown: systemSettings.announcementMarkdown || '',
    version: systemSettings.announcementVersion || '1',
    showOnce: systemSettings.announcementShowOnce !== 'false',
    buttonText: systemSettings.announcementButtonText || '我知道了',
  };

  const allLinkHref = '?';
  const spaceSwitcher = '';

  const categoryLinks = renderCategoryLinks(categoryTree, {
    catalog,
    catalogExists,
    space: currentSpaceSlug,
    expandedNames: new Set(catalogExists ? getAncestorNames(categoryTree, catalog) : []),
    privateUnlocked,
    privateBookmarksVisible,
  });

  const datalistOptions = datalistCategoryNames.map((cat) => `<option value="${escapeHTML(cat)}">`).join('');
  const sortLabel = sortMode === 'hot' ? t('hotBookmarks') : (sortMode === 'recent' ? t('recent') : '');
  const tagLabel = tagFilter ? `#${tagFilter}` : '';
  const heading = privateCatalogLocked
    ? `${PRIVATE_BOOKMARK_CATEGORY} · ${t('locked')}`
    : (catalogExists
      ? `${catalog}${tagLabel ? ` · ${tagLabel}` : ''}${sortLabel ? ` · ${sortLabel}` : ''} · ${t('sitesCount', { count: currentSites.length })}`
      : `${tagLabel || sortLabel || '全部收藏'}${tagLabel && sortLabel ? ` · ${sortLabel}` : ''} · ${t('sitesCount', { count: currentSites.length })}`);
  const sortLinks = renderSortLinks({ catalog, tag: tagFilter, sortMode, space: currentSpaceSlug, disabled: privateCatalogLocked, i18n });
  // 性能优化：默认 grid 布局分页渲染（首屏只渲染前 GRID_PAGE_SIZE 个书签）；
  // grouped/dashboard 由客户端切换到该布局时以 ?layout=grouped|dashboard 片段请求按需拉取；
  // grid 后续页以 ?layout=grid&page=N 片段追加。
  const GRID_PAGE_SIZE = 60;
  const gridPage = Math.max(1, Number(url.searchParams.get('page')) || 1);
  const requestedLayout = String(url.searchParams.get('layout') || '').toLowerCase();
  if (requestedLayout === 'grid') {
    const start = (gridPage - 1) * GRID_PAGE_SIZE;
    const pageCards = privateCatalogLocked
      ? ''
      : currentSites.slice(start, start + GRID_PAGE_SIZE).map((site) => renderSiteCard(site, canDragSort, adminAuthed, i18n)).join('');
    const response = htmlResponse(pageCards, 200, { 'Cache-Control': 'no-store' });
    response.headers.set('X-Sites-Total', String(currentSites.length));
    return response;
  }
  if (requestedLayout === 'grouped' || requestedLayout === 'dashboard') {
    const fragment = privateCatalogLocked
      ? renderPrivateBookmarkUnlockBox(catalog, i18n)
      : requestedLayout === 'grouped'
        ? renderGroupedSites(currentSites, adminAuthed, i18n)
        : renderDashboardSites(currentSites, adminAuthed, i18n);
    return htmlResponse(fragment, 200, { 'Cache-Control': 'no-store' });
  }
  const gridContent = privateCatalogLocked
    ? renderPrivateBookmarkUnlockBox(catalog, i18n)
    : currentSites.slice(0, GRID_PAGE_SIZE).map((site) => renderSiteCard(site, canDragSort, adminAuthed, i18n)).join('');
  const hasMoreGrid = !privateCatalogLocked && currentSites.length > GRID_PAGE_SIZE;

  return htmlResponse(`<!DOCTYPE html>
<html lang="${escapeHTML(lang)}" dir="${escapeHTML(dir)}">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(siteName)}</title>
  <meta name="theme-color" content="${escapeHTML(defaultAccent === 'green' ? '#265c44' : (defaultAccent === 'purple' ? '#5b3b8c' : (defaultAccent === 'rose' ? '#9f3758' : (defaultAccent === 'amber' ? '#8a5a16' : '#254267'))))}">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="${escapeHTML(siteName)}">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="apple-touch-icon" href="${escapeHTML(siteIcon)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap" rel="stylesheet"/>
  <link rel="icon" href="${escapeHTML(siteIcon)}"/>
  <link rel="alternate icon" href="https://img.12388888.xyz/file/logo/ktVNDfcM.png" type="image/png"/>
  <link rel="stylesheet" href="/static/home.css?v=${homeCssVersion}"/>
  <script>
    (function(){try{const root=document.documentElement;const saved=localStorage.getItem('nav:theme');const prefersDark=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;if(saved==='dark'||(!saved&&prefersDark)){root.classList.add('dark')}var defaultAccent='${escapeHTML(defaultAccent)}',defaultLayout='${escapeHTML(defaultLayout)}',defaultBg='${pageBackgroundImage ? 'image' : 'soft'}';root.dataset.accent=localStorage.getItem('nav:accent')||defaultAccent;root.dataset.density=localStorage.getItem('nav:density')||'comfortable';root.dataset.bg=localStorage.getItem('nav:bg')||defaultBg;root.dataset.view=localStorage.getItem('nav:view')||'detail';root.dataset.layout=localStorage.getItem('nav:layout')||defaultLayout;var bgImage=localStorage.getItem('nav:bgImage')||'${escapeHTML(pageBackgroundImage)}';if(bgImage)document.documentElement.style.setProperty('--nav-bg-image','url('+bgImage+')');var now=new Date(),m=now.getMonth()+1,d=now.getDate();var festival='';if(m===1&&d<=3)festival='newyear';else if(m===2&&d===14)festival='valentine';else if(m===12&&(d>=24&&d<=25))festival='christmas';else if(m===10&&d===31)festival='halloween';else if(m===5&&d>=1&&d<=3)festival='labor';root.dataset.festival=festival}catch(e){}})();
  </script>
</head>
<body class="bg-secondary-50 text-gray-800">
  <div class="fixed top-4 left-4 z-50 lg:hidden"><button id="sidebarToggle" class="flex h-10 w-10 items-center justify-center rounded-lg bg-white text-xl leading-none shadow-md">☰</button></div>
  <button id="expandSidebar" class="hidden lg:block fixed top-4 left-4 z-40 p-2 rounded-lg bg-white shadow-md hover:bg-gray-50 transition" title="展开侧栏">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  </button>
  <div id="mobileOverlay" class="fixed inset-0 bg-black bg-opacity-50 z-40 mobile-overlay lg:hidden"></div>
  <aside id="sidebar" class="fixed left-0 top-0 h-full w-64 bg-white shadow-md border-r border-primary-100/60 z-50 overflow-y-auto mobile-sidebar">
    <div class="p-6">
      <div class="flex items-center justify-between mb-8">
        <h2 class="text-2xl font-bold text-primary-600">${escapeHTML(siteName)}</h2>
        <div class="flex items-center gap-2">
          <button id="themeToggle" class="p-1.5 rounded-lg hover:bg-gray-100 transition" title="切换深色/浅色模式" aria-label="切换深色/浅色模式">🌙</button>
          <button id="collapseSidebar" class="hidden lg:block p-1.5 rounded-lg hover:bg-gray-100 transition collapse-btn" title="收起侧栏">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button id="closeSidebar" class="lg:hidden p-1.5 text-2xl leading-none text-gray-600">×</button>
        </div>
      </div>
      <div class="mb-6 sticky top-0 bg-white z-10 pt-2 pb-2 -mt-2">
        <input id="searchInput" type="text" placeholder="搜索书签..." class="w-full px-4 py-2 border border-primary-100 rounded-lg shadow-sm">
        <div id="searchHistoryBox" class="mt-3 hidden">
          <div class="mb-1.5 flex items-center justify-between text-[11px] text-gray-500">
            <span>最近搜索</span>
            <button type="button" id="clearSearchHistory" class="hover:text-primary-600">清空</button>
          </div>
          <div id="searchHistoryList" class="flex flex-wrap gap-1.5"></div>
        </div>
      </div>
      ${spaceSwitcher}
      <div class="flex items-center justify-between mb-3">
        <h3 class="text-sm font-medium text-gray-500 uppercase">${th('categoryNav')}</h3>
        <input type="text" id="categoryFilterInput" placeholder="过滤分类..." class="w-28 px-2 py-1 text-xs border border-primary-100 rounded bg-gray-50 focus:bg-white outline-none focus:border-primary-300 transition dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200">
      </div>
      <div class="space-y-1" id="categoryList">
        <a href="${escapeHTML(allLinkHref)}" class="category-all-button flex items-center px-3 py-2 rounded-lg w-full">${th('all')}</a>
        ${categoryLinks}
      </div>
        ${privateUnlocked && !adminAuthed ? `<form method="post" action="/" class="mt-3"><input type="hidden" name="_action" value="logout-private"><button type="submit" class="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-700 hover:bg-amber-100">${th('exitPrivate')}</button></form>` : ''}
        ${submissionEnabled ? `<button id="addSiteBtnSidebar" class="w-full px-4 py-2 bg-accent-500 text-white rounded-lg">${th('addBookmark')}</button>` : `<div class="text-xs text-primary-600 border rounded-lg p-3">${th('submissionClosed')}</div>`}
        ${blogLink}
        <a href="/admin" target="_blank" class="mt-4 flex items-center justify-between gap-3 px-4 py-2 text-gray-600 hover:text-primary-500 transition duration-300">
          <span class="flex min-w-0 items-center">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 mr-2 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5.121 17.804A8.966 8.966 0 0112 15c2.21 0 4.236.8 5.879 2.129M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3a9 9 0 100 18 9 9 0 000-18z" />
            </svg>
            <span class="truncate">${th('adminPanel')}</span>
          </span>
          ${adminAuthed ? `<span class="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-sky-500 text-white shadow-sm ring-2 ring-sky-100" title="管理员已认证，可在前台编辑和拖拽排序" aria-label="管理员已认证">
            <svg xmlns="http://www.w3.org/2000/svg" class="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
              <path fill-rule="evenodd" d="M16.704 5.296a1 1 0 010 1.414l-7.25 7.25a1 1 0 01-1.414 0l-3.25-3.25a1 1 0 111.414-1.414l2.543 2.543 6.543-6.543a1 1 0 011.414 0z" clip-rule="evenodd" />
            </svg>
          </span>` : ''}
        </a>
      </div>
    </div>
  </aside>

  <main class="lg:ml-64 min-h-screen main-content">
    ${heroVisible ? `<header class="bg-primary-700 text-white py-10 px-6 md:px-10 border-b border-primary-600 shadow-sm">
      <div class="max-w-5xl mx-auto flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div class="flex-1 text-center md:text-left">
          <span class="inline-flex rounded-full bg-primary-600/70 px-3 py-1 text-[11px] uppercase tracking-[.28em] text-secondary-200/80">${th('heroBadge')}</span>
          <h1 class="mt-4 text-3xl md:text-4xl font-semibold">${escapeHTML(siteName)}</h1>
          <p class="mt-3 text-sm md:text-base text-secondary-100/90">${escapeHTML(siteSubtitle)}</p>
        </div>
        <div class="rounded-2xl bg-white/10 px-6 py-5 shadow-lg border border-white/10"><p class="text-xs uppercase tracking-[.28em]">${th('overview')}</p><p class="mt-3 text-2xl font-semibold">${visibleSites.length}</p><p class="text-sm">${th('categoryCount', { count: categoryNames.length })}</p></div>
      </div>
    </header>` : ''}

    <section class="max-w-7xl mx-auto px-4 sm:px-6 py-8">
      <div id="myUsageSection" class="hidden mb-6 grid gap-4 md:grid-cols-2">
        <div class="usage-card rounded-2xl border border-primary-100/60 bg-white/80 p-4 shadow-sm min-w-0" data-usage="favorites">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700">⭐ 我的收藏</h3>
            <button type="button" data-usage-clear="favorites" class="text-[11px] text-gray-400 hover:text-primary-600">清空</button>
          </div>
          <div data-usage-list="favorites" class="flex gap-2 text-xs overflow-x-auto pb-1 scrollbar-hide snap-x"></div>
          <p class="usage-empty mt-1 text-[11px] text-gray-400">点击任意书签卡片右上角的 ⭐ 加入收藏</p>
        </div>
        <div class="usage-card rounded-2xl border border-primary-100/60 bg-white/80 p-4 shadow-sm min-w-0" data-usage="recent">
          <div class="mb-2 flex items-center justify-between">
            <h3 class="text-sm font-semibold text-gray-700">🕘 最近访问</h3>
            <button type="button" data-usage-clear="recent" class="text-[11px] text-gray-400 hover:text-primary-600">清空</button>
          </div>
          <div data-usage-list="recent" class="flex gap-2 text-xs overflow-x-auto pb-1 scrollbar-hide snap-x"></div>
          <p class="usage-empty mt-1 text-[11px] text-gray-400">访问书签后这里会自动记录最近 12 条</p>
        </div>
      </div>
      <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-6">
        <h2 id="listHeading" class="text-xl font-semibold text-gray-800">${escapeHTML(heading)}</h2>
        <div class="flex flex-wrap items-center gap-2">
          <div class="layout-mode-bar hidden sm:flex rounded-full border border-primary-100 bg-white p-1 shadow-sm" aria-label="${th('layoutMode')}">
            <button type="button" class="layout-toggle px-3 py-1.5 rounded-full text-sm text-gray-600" data-layout="grid" title="${th('gridTitle')}">${th('grid')}</button>
            <button type="button" class="layout-toggle px-3 py-1.5 rounded-full text-sm text-gray-600" data-layout="list" title="${th('listTitle')}">${th('list')}</button>
            <button type="button" class="layout-toggle px-3 py-1.5 rounded-full text-sm text-gray-600" data-layout="grouped" title="${th('groupedTitle')}">${th('grouped')}</button>
            <button type="button" class="layout-toggle px-3 py-1.5 rounded-full text-sm text-gray-600" data-layout="masonry" title="${th('masonryTitle')}">${th('masonry')}</button>
            <button type="button" class="layout-toggle px-3 py-1.5 rounded-full text-sm text-gray-600" data-layout="dashboard" title="${th('dashboardTitle')}">${th('dashboard')}</button>
          </div>
          ${sortLinks}
          ${canDragSort ? `<button id="saveOrderBtn" class="px-4 py-2 rounded-lg bg-accent-500 text-white disabled:opacity-50" disabled>${th('saveDragSort')}</button>` : ''}
        </div>
      </div>
      <div id="sitesPanel" class="rounded-2xl border border-primary-100/60 bg-white/80 p-4 sm:p-6 shadow-sm">
        <div id="layoutGridPanel" class="layout-panel active">
          <div id="sitesGrid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6">
            ${gridContent}
          </div>
          ${hasMoreGrid ? `<div class="mt-6 text-center"><button type="button" id="loadMoreSites" class="rounded-full border border-primary-200 bg-white px-6 py-2.5 text-sm font-medium text-primary-700 shadow-sm hover:bg-primary-50">加载更多（剩余 ${currentSites.length - GRID_PAGE_SIZE} 个）</button></div>` : ''}
        </div>
        <div id="layoutGroupedPanel" class="layout-panel">
          <!-- 懒加载：切换到分组布局时按需拉取 ?layout=grouped 片段 -->
        </div>
        <div id="layoutDashboardPanel" class="layout-panel">
          <!-- 懒加载：切换到概览布局时按需拉取 ?layout=dashboard 片段 -->
        </div>
      </div>
    </section>
    <footer class="bg-white py-8 px-6 mt-12 border-t border-primary-100 text-center text-gray-500">© ${new Date().getFullYear()} ${escapeHTML(siteName)} | ${escapeHTML(footerText)}</footer>
  </main>

  <div class="fixed bottom-5 right-5 z-[70] flex flex-col items-end gap-3 floating-actions">
    <div id="floatingThemePanel" class="theme-panel floating-theme-panel hidden w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-primary-100/60 bg-white/95 p-4 shadow-2xl">
      <div class="mb-3 flex items-center justify-between">
        <div>
          <h3 class="text-sm font-semibold text-gray-900">${th('themeSettings')}</h3>
          <p class="text-xs text-gray-500">${th('themeDesc')}</p>
        </div>
        <button type="button" id="resetThemePrefs" class="text-xs text-primary-600 hover:underline">${th('reset')}</button>
      </div>
      <div class="space-y-3 text-xs text-gray-600">
        <div>
          <div class="mb-1.5 font-medium">预设主题</div>
          <div class="grid grid-cols-3 gap-1.5" id="themePresetGroup">
            <button type="button" class="theme-preset-btn theme-segment" data-preset="starry" title="星空主题：深蓝主色 + 柔和背景 + 卡片布局">🌌 星空</button>
            <button type="button" class="theme-preset-btn theme-segment" data-preset="minimal" title="极简白：浅色纯净 + 紧凑密度 + 列表布局">⬜ 极简</button>
            <button type="button" class="theme-preset-btn theme-segment" data-preset="dark" title="暗黑模式：深色主题 + 渐变背景">🌙 暗黑</button>
            <button type="button" class="theme-preset-btn theme-segment" data-preset="glass" title="毛玻璃：紫色主题 + 渐变背景 + 宽松密度">🪟 玻璃</button>
            <button type="button" class="theme-preset-btn theme-segment" data-preset="dock" title="Mac Dock：绿色主题 + 图标宫格 + 紧凑密度">💻 Dock</button>
            <button type="button" class="theme-preset-btn theme-segment" data-preset="notion" title="Notion 风格：琥珀主题 + 纸纹背景 + 列表布局">📝 Notion</button>
          </div>
        </div>
        <div>
          <div class="mb-1.5 font-medium">${th('themeColor')}</div>
          <div class="grid grid-cols-5 gap-1.5" data-theme-group="accent">
            <button type="button" class="theme-choice h-7 rounded-full bg-[#254267] ring-offset-2" data-theme-key="accent" data-theme-value="blue" title="星空蓝"></button>
            <button type="button" class="theme-choice h-7 rounded-full bg-[#3c976d] ring-offset-2" data-theme-key="accent" data-theme-value="green" title="森林绿"></button>
            <button type="button" class="theme-choice h-7 rounded-full bg-[#8b5cf6] ring-offset-2" data-theme-key="accent" data-theme-value="purple" title="暮光紫"></button>
            <button type="button" class="theme-choice h-7 rounded-full bg-[#e0527d] ring-offset-2" data-theme-key="accent" data-theme-value="rose" title="蔷薇红"></button>
            <button type="button" class="theme-choice h-7 rounded-full bg-[#d97706] ring-offset-2" data-theme-key="accent" data-theme-value="amber" title="琥珀金"></button>
          </div>
        </div>
        <div>
          <div class="mb-1.5 font-medium">${th('density')}</div>
          <div class="grid grid-cols-3 gap-1.5" data-theme-group="density">
            <button type="button" class="theme-segment" data-theme-key="density" data-theme-value="compact">${th('compact')}</button>
            <button type="button" class="theme-segment" data-theme-key="density" data-theme-value="comfortable">${th('comfortable')}</button>
            <button type="button" class="theme-segment" data-theme-key="density" data-theme-value="spacious">${th('spacious')}</button>
          </div>
        </div>
        <div>
          <div class="mb-1.5 font-medium">${th('bgStyle')}</div>
          <div class="grid grid-cols-4 gap-1.5" data-theme-group="bg">
            <button type="button" class="theme-segment" data-theme-key="bg" data-theme-value="plain">${th('plain')}</button>
            <button type="button" class="theme-segment" data-theme-key="bg" data-theme-value="soft">${th('soft')}</button>
            <button type="button" class="theme-segment" data-theme-key="bg" data-theme-value="gradient">${th('gradient')}</button>
            <button type="button" class="theme-segment" data-theme-key="bg" data-theme-value="paper">${th('paper')}</button>
            <button type="button" class="theme-segment" data-theme-key="bg" data-theme-value="image">图片</button>
          </div>
          <div id="bgImageUrlBox" class="mt-1.5 hidden">
            <input id="bgImageUrlInput" type="url" placeholder="背景图片 URL" class="w-full rounded-lg border border-primary-100/60 bg-white px-2.5 py-1.5 text-[11px] outline-none focus:border-primary-300">
          </div>
        </div>
        <div>
          <div class="mb-1.5 font-medium">${th('viewMode')}</div>
          <div class="grid grid-cols-2 gap-1.5" data-theme-group="view">
            <button type="button" class="theme-segment" data-theme-key="view" data-theme-value="detail">${th('detail')}</button>
            <button type="button" class="theme-segment" data-theme-key="view" data-theme-value="minimal">${th('minimal')}</button>
          </div>
        </div>
        <div>
          <div class="mb-1.5 font-medium">${th('homeLayout')}</div>
          <div class="grid grid-cols-3 gap-1.5" data-theme-group="layout">
            <button type="button" class="theme-segment" data-theme-key="layout" data-theme-value="grid">卡片</button>
            <button type="button" class="theme-segment" data-theme-key="layout" data-theme-value="list">列表</button>
            <button type="button" class="theme-segment" data-theme-key="layout" data-theme-value="grouped">分组</button>
            <button type="button" class="theme-segment" data-theme-key="layout" data-theme-value="masonry">瀑布</button>
            <button type="button" class="theme-segment" data-theme-key="layout" data-theme-value="dashboard">概览</button>
          </div>
        </div>
      </div>
    </div>
    <div id="floatingAiPanel" class="floating-ai-panel hidden w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-primary-100/60 bg-white/95 shadow-2xl">
      <div class="flex items-center justify-between border-b border-primary-100/60 px-4 py-3">
        <div>
          <h3 class="text-sm font-semibold text-gray-900">AI 书签助理</h3>
          <p class="text-xs text-gray-500">优先检索本站书签，再生成回复</p>
        </div>
        <div class="flex items-center gap-1">
          <button type="button" id="toggleAiFullscreen" class="rounded-full px-2 py-1 text-xs text-gray-500 hover:bg-primary-50" aria-label="全屏显示 AI 助理" title="全屏显示">全屏</button>
          <button type="button" id="closeAiPanel" class="rounded-full px-2 py-1 text-gray-500 hover:bg-primary-50" aria-label="关闭 AI 助理">×</button>
        </div>
      </div>
      <div id="aiChatBody" class="ai-chat-body space-y-3 p-4">
        <div class="ai-message assistant">你好，我是本站 AI 书签助理。你可以问我：“有没有图片压缩工具？”、“某个网站放在哪个分类？”、“帮我找设计相关书签”。</div>
      </div>
      <form id="aiChatForm" class="border-t border-primary-100/60 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]">
        <div class="flex gap-2">
          <input id="aiChatInput" class="min-w-0 flex-1 rounded-xl border border-primary-100 px-3 py-2 text-sm outline-none focus:border-primary-300" placeholder="输入你想找的书签或问题..." autocomplete="off">
          <button id="aiSendBtn" type="submit" class="rounded-xl bg-primary-600 px-4 py-2 text-sm font-medium text-white">发送</button>
        </div>
        <p class="mt-2 text-[11px] text-gray-500">未配置模型时会自动使用本地书签检索结果回答。</p>
      </form>
    </div>
    <div class="floating-action-stack" role="toolbar" aria-label="快捷操作">
      <button type="button" id="floatingAiToggle" class="floating-action-btn" title="${th('aiAssistant')}" aria-expanded="false" aria-controls="floatingAiPanel"><span aria-hidden="true">🤖</span><span class="floating-label">AI</span></button>
      <button type="button" id="floatingThemeToggle" class="floating-action-btn" title="${th('themeSettings')}" aria-expanded="false" aria-controls="floatingThemePanel"><span aria-hidden="true">🎨</span><span class="floating-label">外观</span></button>
      <button type="button" id="backToTopBtn" class="floating-action-btn hidden" title="${th('backToTop')}" aria-label="${th('backToTop')}"><span aria-hidden="true">↑</span><span class="floating-label">顶部</span></button>
    </div>
  </div>

  ${submissionEnabled ? renderSubmitModal(datalistOptions) : ''}
  ${adminAuthed ? renderFrontAdminModal(datalistOptions, i18n) : ''}
  ${announcement.enabled ? renderAnnouncementModal(announcement) : ''}

${homeClientScript({ defaultAccent, pageBackgroundImage, defaultLayout, i18n, myUsageScript, frontAdminScript, dragScript, adminAuthed, canDragSort })}
</body>
</html>`);
}

