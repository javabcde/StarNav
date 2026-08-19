import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// C4 视图拆分：popup.js 变壳，三视图 UMD 模块经 create(ctx) 拿到共享依赖，
// mount/onEnter/onLeave 是视图生命周期 seam。本文件用极简 stub DOM 冒烟：
// 挂载不抛、监听绑定到位、onEnter/onLeave 可调、saveBookmark 行为面走通。
// （替代原 popup-view-persist.test.js 的源码正则锁）
const EXT = new URL('../extensions/browser-bookmark/', import.meta.url);

function loadUmd(file, globalName, { expectFactory = false } = {}) {
  vm.runInThisContext(readFileSync(new URL(file, EXT), 'utf8'));
  const mod = globalThis[globalName];
  assert.ok(mod, `${file} 应挂载全局 ${globalName}`);
  if (expectFactory) assert.equal(typeof mod.create, 'function', `${file} 应导出 create 工厂`);
  return mod;
}

const Contract = loadUmd('extension-contract.js', 'Contract');
const BrowseLogic = loadUmd('popup-logic.js', 'BrowseLogic');
const StarNavCollectView = loadUmd('collect-view.js', 'StarNavCollectView', { expectFactory: true });
const StarNavSyncView = loadUmd('sync-view.js', 'StarNavSyncView', { expectFactory: true });
const StarNavBrowseView = loadUmd('browse-view.js', 'StarNavBrowseView', { expectFactory: true });

// ── 极简 stub DOM ──────────────────────────────────────────
function createStubEl() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    style: {},
    dataset: {},
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    disabled: false,
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    appendChild() {},
    replaceWith() {},
    setProperty() {},
  };
}

function createStubEls() {
  const cache = new Map();
  return new Proxy({}, {
    get(_target, prop) {
      if (!cache.has(prop)) cache.set(prop, createStubEl());
      return cache.get(prop);
    },
  });
}

function createStubDocument() {
  const cache = new Map();
  return {
    getElementById(id) {
      if (!cache.has(id)) cache.set(id, createStubEl());
      return cache.get(id);
    },
    createElement: () => createStubEl(),
  };
}

function createTestCtx({ apiFetchImpl } = {}) {
  const apiCalls = [];
  const apiFetch = async (path, options = {}) => {
    apiCalls.push({ path, options });
    return apiFetchImpl ? apiFetchImpl(path, options) : { data: [] };
  };
  const state = { onCacheMutatedCalls: 0 };
  return {
    els: createStubEls(),
    document: createStubDocument(),
    Contract,
    BrowseLogic,
    config: () => ({ baseUrl: 'https://nav.test', token: 'tok', siteName: '我的导航' }),
    setStatus() {},
    apiFetch,
    escapeHTML: (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    getActiveTab: async () => null,
    onCacheMutated: () => { state.onCacheMutatedCalls += 1; },
    localStorage: {
      getItem: () => null,
      setItem() {},
    },
    apiCalls,
    state,
  };
}

const chromeStub = {
  storage: {
    local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
    sync: { get: async () => ({}) },
  },
  tabs: { query: async () => [], create: async () => {} },
  runtime: { sendMessage: async () => {}, openOptionsPage: async () => {} },
  bookmarks: { getTree: async () => [] },
  action: { setIcon: async () => {} },
};
globalThis.chrome = chromeStub;
globalThis.IntersectionObserver = class { observe() {} disconnect() {} };

test('视图拆分：三个视图工厂均暴露 mount/onEnter/onLeave 生命周期', () => {
  const ctx = createTestCtx();
  const collect = StarNavCollectView.create(ctx);
  const sync = StarNavSyncView.create(ctx);
  const browse = StarNavBrowseView.create(ctx);
  for (const view of [collect, sync, browse]) {
    assert.equal(typeof view.mount, 'function');
    assert.equal(typeof view.onEnter, 'function');
    assert.equal(typeof view.onLeave, 'function');
  }
});

test('collect.mount：绑定全部收藏按钮监听与插件搜索框，不抛异常', () => {
  const ctx = createTestCtx();
  const view = StarNavCollectView.create(ctx);
  assert.doesNotThrow(() => view.mount());
  const listeners = (name) => ctx.els[name].listeners;
  assert.ok(listeners('saveBtn').click, 'saveBtn 应绑定 click');
  assert.ok(listeners('forceSaveBtn').click, 'forceSaveBtn 应绑定 click');
  assert.ok(listeners('fetchBtn').click, 'fetchBtn 应绑定 click');
  assert.ok(listeners('fetchFaviconBtn').click, 'fetchFaviconBtn 应绑定 click');
  assert.ok(listeners('suggestCategoryBtn').click, 'suggestCategoryBtn 应绑定 click');
  assert.ok(listeners('suggestTagsBtn').click, 'suggestTagsBtn 应绑定 click');
  assert.ok(listeners('checkDuplicateBtn').click, 'checkDuplicateBtn 应绑定 click');
  assert.ok(listeners('url').change, 'url 应绑定 change（变更后查重）');
  const searchInput = ctx.document.getElementById('pluginSearchInput');
  assert.ok(searchInput.listeners.input, '插件搜索框应绑定 input');
});

test('collect.onEnter：空 URL 不触发查重请求', () => {
  const ctx = createTestCtx();
  const view = StarNavCollectView.create(ctx);
  view.mount();
  assert.doesNotThrow(() => view.onEnter());
  assert.equal(ctx.apiCalls.length, 0, '空 URL 时不应发起查重请求');
  assert.doesNotThrow(() => view.onLeave());
});

test('collect.saveBookmark：经视图行为面提交 /api/sites 并触发缓存刷新钩子', async () => {
  const ctx = createTestCtx();
  const view = StarNavCollectView.create(ctx);
  ctx.els.name.value = '示例';
  ctx.els.url.value = 'https://example.com';
  ctx.els.catelog.value = '工具';
  ctx.els.tags.value = '';
  ctx.els.visibility.value = 'public';
  ctx.els.logo.value = '';
  await view._handlers.saveBookmark({ force: false });
  assert.equal(ctx.apiCalls.length, 1);
  assert.equal(ctx.apiCalls[0].path, '/api/sites');
  assert.equal(JSON.parse(ctx.apiCalls[0].options.body).name, '示例');
  assert.equal(ctx.state.onCacheMutatedCalls, 1, '保存成功后应刷新浏览缓存');
});

test('sync.mount：绑定同步按钮', () => {
  const ctx = createTestCtx();
  const view = StarNavSyncView.create(ctx);
  assert.doesNotThrow(() => view.mount());
  assert.ok(ctx.els.syncBtn.listeners.click, 'syncBtn 应绑定 click');
  assert.doesNotThrow(() => view.onEnter());
  assert.doesNotThrow(() => view.onLeave());
});

test('browse.mount：绑定浏览交互监听；无缓存时走全量拉取初始化', async () => {
  const ctx = createTestCtx({
    apiFetchImpl: (path) => {
      if (path === '/api/config?all=1') return { data: [], total: 0 };
      if (path === '/api/categories/tree') return { data: [] };
      return { data: [] };
    },
  });
  const view = StarNavBrowseView.create(ctx);
  assert.doesNotThrow(() => view.mount());
  const listeners = (name) => ctx.els[name].listeners;
  assert.ok(listeners('browseSearch').input, 'browseSearch 应绑定 input');
  assert.ok(listeners('browseSort').change, 'browseSort 应绑定 change');
  assert.ok(listeners('browseRefresh').click, 'browseRefresh 应绑定 click');
  assert.ok(listeners('browseMore').click, 'browseMore 应绑定 click');
  assert.ok(listeners('browseList').click, 'browseList 应绑定点击重试委托');
  // 无缓存 → loadFullCache 拉全量 → 空列表渲染空态，不抛异常
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(ctx.apiCalls.some((c) => c.path === '/api/config?all=1'), '应发起全量缓存拉取');
  assert.doesNotThrow(() => view.onEnter());
  assert.doesNotThrow(() => view.onLeave());
  assert.equal(typeof view.refreshAfterCacheMutation, 'function');
});

test('browse 切换分类：清空搜索词并同步清空输入框（防旧词过滤新分类空结果）', () => {
  const src = readFileSync(new URL('browse-view.js', EXT), 'utf8');
  // 两个分支（direct/普通）都必须带 keyword:''（空串非 nullish，才能真正清空）
  assert.match(src, /catelog: parent, direct: true, keyword: ''/, '直属书签切换分支必须清空 keyword');
  assert.match(src, /catelog: cat, direct: false, keyword: ''/, '普通分类切换分支必须清空 keyword');
  assert.match(src, /^\s*els\.browseSearch\.value = '';$/m, '搜索输入框必须同步清空（UI 与状态一致）');
  // 搜索输入分支不得反向清空分类（scope：只做切分类清搜索）
  assert.match(src, /applyBrowseFilter\(browseState, \{ keyword \}\)/, '搜索输入分支保持只改 keyword');
});
