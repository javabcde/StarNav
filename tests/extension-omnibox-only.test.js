import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 地址栏搜索只保留 `q` + 空格一条路径（1.3.0 移除书签镜像）：
// 1. manifest 关键字是用户可见契约，必须与 README/CONTEXT 一致
// 2. 旧版（≤1.2.x）写入的镜像文件夹必须在升级时一次性清理
// 3. 有全量缓存时也不得再向浏览器书签写入镜像（防止镜像方案回潮）
const EXT = new URL('../extensions/browser-bookmark/', import.meta.url);
const read = (name) => readFileSync(new URL(name, EXT), 'utf8');

const MIRROR_KEY = 'bookmark:mirror:folderId';

function createChromeMock(local = {}) {
  const listeners = { installed: [], startup: [] };
  const calls = { create: [], removeTree: [] };
  const event = (buffer) => ({ addListener: (fn) => buffer.push(fn) });

  const tree = [{
    id: '0',
    title: '',
    children: [
      { id: '1', title: '书签栏', children: [] },
      { id: '2', title: '其他书签', children: [] },
    ],
  }];

  const chrome = {
    storage: {
      sync: {
        get: async (keys, callback) => {
          const value = {};
          if (typeof callback === 'function') callback(value);
          return value;
        },
        set: async () => {},
        clear: async () => {},
      },
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
      onChanged: { addListener() {} },
    },
    runtime: {
      onInstalled: event(listeners.installed),
      onStartup: event(listeners.startup),
      onMessage: { addListener() {} },
      openOptionsPage() {},
    },
    contextMenus: {
      update: async () => {},
      create() {},
      onClicked: { addListener() {} },
    },
    notifications: { create() {} },
    windows: { getLastFocused: async () => ({}) },
    tabs: { create() {}, update() {}, query: async () => [] },
    omnibox: {
      onInputStarted: { addListener() {} },
      onInputChanged: { addListener() {} },
      onInputEntered: { addListener() {} },
      setDefaultSuggestion() {},
    },
    bookmarks: {
      getTree: async () => tree,
      getChildren: async (id) => tree[0].children.find((node) => node.id === id)?.children || [],
      get: async (id) => {
        const node = tree[0].children.find((child) => child.id === id);
        if (!node) throw new Error('not found');
        return [node];
      },
      create: async (node) => {
        calls.create.push(node);
        return { id: `created-${calls.create.length}`, ...node };
      },
      update: async () => {},
      remove: async () => {},
      removeTree: async (id) => { calls.removeTree.push(id); },
    },
  };

  return { chrome, calls, listeners, local };
}

function runBackground(mock) {
  const ctx = vm.createContext({ chrome: mock.chrome, setTimeout, clearTimeout, console, URL });
  ctx.importScripts = (...names) => {
    for (const name of names) vm.runInContext(read(name), ctx, { filename: name });
  };
  vm.runInContext(read('background.js'), ctx, { filename: 'background.js' });
}

async function waitFor(predicate, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor timeout');
}

test('manifest：地址栏关键字为 q，bookmarks 权限保留给一键同步', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.omnibox?.keyword, 'q', '地址栏搜索关键字应为 q');
  assert.ok(manifest.permissions.includes('bookmarks'), '一键同步仍需要 bookmarks 权限');
});

test('background：启动时删除旧版镜像文件夹并清除 id，重复启动不重复删除', async () => {
  const mock = createChromeMock({ [MIRROR_KEY]: 'legacy-mirror' });
  runBackground(mock);
  assert.equal(mock.listeners.startup.length, 1, '应注册 onStartup');

  mock.listeners.startup[0]();
  await waitFor(() => !(MIRROR_KEY in mock.local));

  assert.deepEqual(mock.calls.removeTree, ['legacy-mirror'], '应按记录的 id 删除镜像文件夹');
  assert.equal(MIRROR_KEY in mock.local, false, '镜像 id 应清除，避免下次启动重复定位');

  mock.listeners.startup[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(mock.calls.removeTree, ['legacy-mirror'], 'id 已清除后不得再删除任何文件夹');
});

test('background：有全量缓存时也不向浏览器书签写入镜像', async () => {
  const cache = {
    kind: 'full',
    fetchedAt: Date.now(),
    ttlMinutes: 5,
    items: [
      { id: 1, name: 'GitHub', url: 'https://github.com', catelog: '开发', visibility: 'public', tags: [] },
    ],
    total: 1,
    categories: [],
  };
  const mock = createChromeMock({ 'browse:cache:v1': cache });
  runBackground(mock);

  mock.listeners.installed[0]();
  mock.listeners.startup[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.deepEqual(mock.calls.create, [], '不得创建 StarNav 收藏文件夹或书签');
  assert.deepEqual(mock.calls.removeTree, [], '无旧镜像 id 时不得触碰浏览器书签');
  assert.equal(MIRROR_KEY in mock.local, false);
});
