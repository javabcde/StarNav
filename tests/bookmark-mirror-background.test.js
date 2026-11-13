import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// background.js 无运行 seam（chrome API + importScripts），这里用 vm + chrome mock
// 测「镜像接线面」：stale folder id 重建、增量 plan 应用、Chrome 根路径尾斜杠不抖动、
// 开关关闭删除镜像、storage.onChanged 触发。纯逻辑矩阵见 bookmark-mirror-logic.test.js。
const EXT = new URL('../extensions/browser-bookmark/', import.meta.url);
const sources = {
  'extension-contract.js': readFileSync(new URL('extension-contract.js', EXT), 'utf8'),
  'popup-logic.js': readFileSync(new URL('popup-logic.js', EXT), 'utf8'),
  'omnibox-logic.js': readFileSync(new URL('omnibox-logic.js', EXT), 'utf8'),
  'bookmark-mirror-logic.js': readFileSync(new URL('bookmark-mirror-logic.js', EXT), 'utf8'),
};
const backgroundSource = readFileSync(new URL('background.js', EXT), 'utf8');

const PUBLIC_ITEMS = [
  { id: 1, name: 'GitHub', url: 'https://github.com', catelog: '开发', visibility: 'public', tags: ['git'] },
  { id: 2, name: 'React', url: 'https://react.dev', catelog: '前端', visibility: 'public', tags: [] },
  { id: 3, name: '私人收藏', url: 'https://secret.example.com', catelog: '私人书签', visibility: 'private', tags: [] },
];

function fullCache(items = PUBLIC_ITEMS) {
  return { kind: 'full', fetchedAt: Date.now(), ttlMinutes: 5, items, total: items.length, categories: [] };
}

// chrome.bookmarks mock：根节点 id 0，书签栏 1，其他书签 2。
// URL 书签按 Chrome 行为把根路径补成 `https://host/`（回归点：镜像不能因此删建）。
function createBookmarksMock() {
  let seq = 100;
  const nodes = new Map();
  const root = { id: '0', title: '', children: [] };
  const bar = { id: '1', title: '书签栏', children: [] };
  const other = { id: '2', title: '其他书签', children: [] };
  root.children.push(bar, other);
  [root, bar, other].forEach((node) => nodes.set(node.id, node));
  const calls = { create: [], update: [], remove: [], removeTree: [], get: [] };

  function parentOf(id) {
    for (const node of nodes.values()) {
      if (node.children && node.children.some((child) => child.id === id)) return node;
    }
    return null;
  }

  function chromeUrl(url) {
    const parsed = new URL(url);
    if (parsed.pathname === '/' && !parsed.search && !parsed.hash) {
      return `${parsed.protocol}//${parsed.host}/`;
    }
    return url;
  }

  function insert(parentId, title, url) {
    const parent = nodes.get(parentId);
    if (!parent) throw new Error(`parent not found: ${parentId}`);
    const id = String(++seq);
    const node = url ? { id, title, url: chromeUrl(url) } : { id, title, children: [] };
    nodes.set(id, node);
    parent.children.push(node);
    return node;
  }

  const chrome = {
    getTree: async () => [root],
    getChildren: async (id) => (nodes.get(id)?.children || []),
    get: async (id) => {
      calls.get.push(id);
      const node = nodes.get(id);
      if (!node) throw new Error('not found');
      return [node];
    },
    create: async ({ parentId, title, url }) => {
      const node = insert(parentId, title, url);
      calls.create.push({ id: node.id, parentId, title, url: node.url || '' });
      return node;
    },
    update: async (id, changes) => {
      const node = nodes.get(id);
      if (!node) throw new Error('not found');
      Object.assign(node, changes);
      calls.update.push({ id, ...changes });
      return node;
    },
    remove: async (id) => {
      const parent = parentOf(id);
      if (parent) parent.children = parent.children.filter((child) => child.id !== id);
      nodes.delete(id);
      calls.remove.push(id);
    },
    removeTree: async (id) => {
      const parent = parentOf(id);
      if (parent) parent.children = parent.children.filter((child) => child.id !== id);
      const stack = [id];
      while (stack.length) {
        const current = nodes.get(stack.pop());
        if (!current) continue;
        for (const child of current.children || []) stack.push(child.id);
        nodes.delete(current.id);
      }
      calls.removeTree.push(id);
    },
  };

  return {
    chrome,
    other,
    calls,
    addFolder(title, parentId = '2') {
      return insert(parentId, title);
    },
    addBookmark(parentId, title, url) {
      return insert(parentId, title, url);
    },
  };
}

function createChromeMock({ config = {}, local = {} } = {}) {
  const bookmarks = createBookmarksMock();
  const syncConfig = {
    baseUrl: 'https://nav.test',
    token: 'test-token',
    browseCacheMinutes: 5,
    mirrorBookmarks: true,
    ...config,
  };
  let onChanged = null;
  const event = () => ({ addListener() {} });

  const chrome = {
    storage: {
      sync: { get: async () => ({ ...syncConfig }), set: async () => {}, clear: async () => {} },
      local: {
        get: async (keys) => {
          const wanted = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const key of wanted) if (key in local) out[key] = local[key];
          return out;
        },
        set: async (obj) => { Object.assign(local, obj); },
        remove: async (keys) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete local[key];
        },
        clear: async () => {
          for (const key of Object.keys(local)) delete local[key];
        },
      },
      onChanged: {
        addListener(fn) { onChanged = fn; },
      },
    },
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      openOptionsPage() {},
    },
    contextMenus: {
      update: async () => {},
      create() {},
      onClicked: event(),
    },
    notifications: { create() {} },
    windows: { getLastFocused: async () => ({}) },
    tabs: { create() {}, update() {}, query: async () => [] },
    omnibox: {
      onInputStarted: event(),
      onInputChanged: event(),
      onInputEntered: event(),
      setDefaultSuggestion() {},
    },
    bookmarks: bookmarks.chrome,
  };

  return { chrome, bookmarks, local, getOnChanged: () => onChanged };
}

function createEnv({ config, local = {}, mirrorFolderId = '' } = {}) {
  const mock = createChromeMock({ config, local });
  if (mirrorFolderId) mock.local['bookmark:mirror:folderId'] = mirrorFolderId;
  const ctx = vm.createContext({
    chrome: mock.chrome,
    setTimeout,
    clearTimeout,
    console,
    URL,
  });
  ctx.importScripts = (...names) => {
    for (const name of names) {
      if (!sources[name]) throw new Error(`missing script: ${name}`);
      vm.runInContext(sources[name], ctx, { filename: name });
    }
  };
  vm.runInContext(backgroundSource, ctx, { filename: 'background.js' });
  return { ...mock, ctx };
}

function mirrorFolder(env) {
  return env.bookmarks.other.children.find((node) => !node.url && node.title === 'StarNav 收藏');
}

function withCache(items) {
  return { 'browse:cache:v1': fullCache(items) };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timeout');
}

test('background 镜像：stale folder id 重建文件夹，只写入非私人收藏', async () => {
  const env = createEnv({ local: withCache(), mirrorFolderId: 'stale-folder' });
  await env.ctx.syncBookmarkMirror();

  const folder = mirrorFolder(env);
  assert.ok(folder, '应在「其他书签」下创建镜像文件夹');
  assert.notEqual(folder.id, 'stale-folder', 'stale id 不得继续使用');
  assert.equal(env.local['bookmark:mirror:folderId'], folder.id, '新文件夹 id 应写回 storage');
  assert.deepEqual(folder.children.map((child) => child.title), ['GitHub', 'React']);
  assert.equal(folder.children.some((child) => child.url.includes('secret')), false, '私人书签不进入镜像');
  assert.deepEqual(env.bookmarks.calls.get, ['stale-folder'], '应先检查旧 id 是否失效');
});

test('background 镜像：第二次同步按 Chrome 归一化 URL 配对，不产生删建抖动', async () => {
  const env = createEnv({ local: withCache() });
  await env.ctx.syncBookmarkMirror();
  const folder = mirrorFolder(env);
  const before = folder.children.map((child) => ({ id: child.id, title: child.title, url: child.url }));
  const createCount = env.bookmarks.calls.create.length;

  await env.ctx.syncBookmarkMirror();

  assert.deepEqual(
    folder.children.map((child) => ({ id: child.id, title: child.title, url: child.url })),
    before,
    '重复同步必须保留书签 id（Chrome 会把 https://host 存成 https://host/）',
  );
  assert.equal(env.bookmarks.calls.create.length, createCount, '不应重复 create');
  assert.equal(env.bookmarks.calls.remove.length, 0, '不应 remove');
});

test('background 镜像：改名保留 id、消失项删除、新增项创建', async () => {
  const env = createEnv({ local: withCache() });
  await env.ctx.syncBookmarkMirror();
  const folder = mirrorFolder(env);
  const githubId = folder.children.find((child) => child.url.includes('github')).id;
  const reactId = folder.children.find((child) => child.url.includes('react')).id;

  env.local['browse:cache:v1'].items = [
    { id: 1, name: 'GitHub 官方', url: 'https://github.com', catelog: '开发', visibility: 'public' },
    { id: 4, name: 'Stack Overflow', url: 'https://stackoverflow.com', catelog: '开发', visibility: 'public' },
  ];
  await env.ctx.syncBookmarkMirror();

  const github = folder.children.find((child) => child.url.includes('github'));
  assert.equal(github.id, githubId, '改名不应重建书签');
  assert.equal(github.title, 'GitHub 官方');
  assert.equal(folder.children.some((child) => child.url.includes('react')), false, '缓存消失项应删除');
  assert.ok(folder.children.some((child) => child.url.includes('stackoverflow')), '新增项应创建');
  assert.ok(env.bookmarks.calls.update.some((call) => call.id === githubId), '应走 update');
  assert.ok(env.bookmarks.calls.remove.includes(reactId), '应删除 React');
});

test('background 镜像：关闭开关删除镜像文件夹，保留用户自己的文件夹', async () => {
  const env = createEnv({ local: withCache() });
  await env.ctx.syncBookmarkMirror();
  const mirror = mirrorFolder(env);
  const userFolder = env.bookmarks.addFolder('用户文件夹');
  env.bookmarks.addBookmark(userFolder.id, '用户书签', 'https://user.example.com');

  await env.ctx.removeBookmarkMirror();

  assert.equal(env.bookmarks.other.children.some((node) => node.id === mirror.id), false, '镜像文件夹应删除');
  assert.equal(env.bookmarks.other.children.some((node) => node.id === userFolder.id), true, '用户文件夹应保留');
  assert.equal(env.local['bookmark:mirror:folderId'], undefined, '镜像 id 应清除');
});

test('background 镜像：开关关闭不创建；缓存 onChanged 触发镜像', async () => {
  const disabled = createEnv({ config: { mirrorBookmarks: false }, local: withCache() });
  await disabled.ctx.syncBookmarkMirror();
  assert.equal(mirrorFolder(disabled), undefined, '开关关闭时不得创建镜像');

  const env = createEnv({ local: {} });
  const onChanged = env.getOnChanged();
  assert.equal(typeof onChanged, 'function', 'background 应注册 storage.onChanged');
  const cache = fullCache();
  env.local['browse:cache:v1'] = cache;
  onChanged({ 'browse:cache:v1': { newValue: cache } }, 'local');
  await waitFor(() => Boolean(mirrorFolder(env)));
  assert.deepEqual(mirrorFolder(env).children.map((child) => child.title), ['GitHub', 'React']);
});

test('background 镜像：不接管用户同名 StarNav 收藏 文件夹', async () => {
  const env = createEnv({ local: withCache() });
  const userFolder = env.bookmarks.addFolder('StarNav 收藏');
  env.bookmarks.addBookmark(userFolder.id, 'User Keep', 'https://user-keep.example.com');

  await env.ctx.syncBookmarkMirror();

  const folders = env.bookmarks.other.children.filter((node) => !node.url && node.title === 'StarNav 收藏');
  assert.equal(folders.length, 2, '用户同名文件夹与插件镜像应并存');
  const mirror = folders.find((folder) => folder.id === env.local['bookmark:mirror:folderId']);
  assert.ok(mirror, 'storage 中应记录插件自己的文件夹 id');
  assert.notEqual(mirror.id, userFolder.id, '不得把用户文件夹当作镜像');
  assert.equal(userFolder.children.some((child) => child.title === 'User Keep'), true, '用户书签不得被删除');
  assert.deepEqual(mirror.children.map((child) => child.title), ['GitHub', 'React']);
});
