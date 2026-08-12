import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDuplicateUrlKey } from '../src/services/siteService.js';
import {
  syncBookmarks,
  unsyncSite,
  normalizeSyncSnapshot,
  SYNC_EMPTY_SNAPSHOT_ERROR,
} from '../src/services/bookmarkSyncService.js';

/**
 * 内存版 D1 mock：sites/categories/operation_logs 表 + batch 支持。
 * 未知 SQL 走安全默认（不抛错），供 logOperation 的 webhook 分支兜底。
 */
function createMockEnv() {
  const sites = new Map();
  const categories = new Map();
  const logs = [];
  let nextSiteId = 100;
  let nextCategoryId = 10;

  function findSiteById(id) {
    return sites.get(Number(id));
  }

  function handle(sql, binds) {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM sites WHERE sync_source = ?')) {
      return { rows: [...sites.values()].filter((r) => r.sync_source === binds[0]) };
    }
    if (s.startsWith('SELECT url FROM sites WHERE sync_source IS NULL OR sync_source != ?')) {
      return { rows: [...sites.values()].filter((r) => r.sync_source !== binds[0]).map((r) => ({ url: r.url })) };
    }
    if (s.startsWith('INSERT INTO sites ')) {
      const row = {
        id: nextSiteId++,
        name: binds[0],
        url: binds[1],
        logo: null,
        desc: null,
        catelog: binds[2],
        category_id: binds[3],
        space_id: null,
        visibility: 'public',
        sort_order: 9999,
        hits: 0,
        url_key: binds[4],
        sync_source: binds[5],
        browser_bookmark_id: binds[6],
      };
      sites.set(row.id, row);
      return { meta: { last_row_id: row.id, changes: 1 } };
    }
    if (s.startsWith('UPDATE sites SET name = ?, url = ?, catelog = ?, category_id = ?, url_key = ?')) {
      const site = findSiteById(binds[5]);
      if (!site) return { meta: { changes: 0 } };
      site.name = binds[0];
      site.url = binds[1];
      site.catelog = binds[2];
      site.category_id = binds[3];
      site.url_key = binds[4];
      return { meta: { changes: 1 } };
    }
    if (s.startsWith('DELETE FROM sites WHERE id = ?')) {
      const ok = sites.delete(Number(binds[0]));
      return { meta: { changes: ok ? 1 : 0 } };
    }
    if (s.startsWith('UPDATE sites SET sync_source = ?, browser_bookmark_id = NULL')) {
      const site = findSiteById(binds[1]);
      if (!site || site.sync_source !== binds[2]) return { meta: { changes: 0 } };
      site.sync_source = binds[0];
      site.browser_bookmark_id = null;
      return { meta: { changes: 1 } };
    }
    if (s.startsWith('SELECT 1 AS found FROM sites WHERE id = ?')) {
      return { row: findSiteById(binds[0]) ? { found: 1 } : null };
    }
    if (s.startsWith('INSERT INTO operation_logs ')) {
      logs.push({ action: binds[0], target: binds[1], targetId: binds[2], summary: binds[3], detail: binds[4], ip: binds[5] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith('INSERT INTO categories ')) {
      const name = binds[0];
      if (!categories.has(name)) categories.set(name, { id: nextCategoryId++, name, sort_order: binds[1] });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith('INSERT INTO category_orders ')) return { meta: { changes: 1 } };
    if (s.startsWith('SELECT * FROM categories WHERE name = ?')) {
      return { row: categories.get(binds[0]) || null };
    }
    return { rows: [] };
  }

  const navDb = {
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async all() {
              const out = handle(sql, binds);
              return { results: out.rows ?? [] };
            },
            async first() {
              const out = handle(sql, binds);
              return out.row !== undefined ? out.row : (out.rows?.[0] ?? null);
            },
            async run() {
              const out = handle(sql, binds);
              return { success: true, meta: out.meta ?? { changes: 0 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      const out = [];
      for (const stmt of statements || []) out.push(await stmt.run());
      return out;
    },
  };

  return { env: { NAV_DB: navDb }, sites, categories, logs };
}

function seedSite(m, id, overrides = {}) {
  const row = {
    id,
    name: `站点${id}`,
    url: `https://site${id}.example.com/`,
    logo: null,
    desc: null,
    catelog: '未分类',
    category_id: null,
    space_id: null,
    visibility: 'public',
    sort_order: 9999,
    hits: 0,
    url_key: '',
    sync_source: 'manual',
    browser_bookmark_id: null,
    ...overrides,
  };
  row.url_key = overrides.url_key ?? normalizeDuplicateUrlKey(row.url);
  m.sites.set(id, row);
  return row;
}

test('空快照拒绝执行（空快照保护）', async () => {
  const m = createMockEnv();
  await assert.rejects(
    () => syncBookmarks(m.env, []),
    (err) => err?.message === SYNC_EMPTY_SNAPSHOT_ERROR
  );
});

test('全非法快照拒绝执行（等价空快照）', async () => {
  const m = createMockEnv();
  await assert.rejects(
    () => syncBookmarks(m.env, [{ title: '无URL', url: '' }, { title: 'x', url: '://bad' }]),
    (err) => err?.message === SYNC_EMPTY_SNAPSHOT_ERROR
  );
});

test('新增：顶层书签归未分类，嵌套文件夹拍平建分类', async () => {
  const m = createMockEnv();
  const result = await syncBookmarks(m.env, [
    { id: 'c1', title: '顶栏书签', url: 'https://top.example.com/', folderPath: '' },
    { id: 'c2', title: '开发文档', url: 'https://docs.example.com/', folderPath: '工作/开发' },
  ]);
  assert.equal(result.stats.added, 2);
  assert.equal(result.stats.deleted, 0);
  const top = [...m.sites.values()].find((s) => s.browser_bookmark_id === 'c1');
  const dev = [...m.sites.values()].find((s) => s.browser_bookmark_id === 'c2');
  assert.equal(top.sync_source, 'browser');
  assert.equal(top.catelog, '未分类');
  assert.equal(dev.catelog, '工作/开发');
  assert.ok(m.categories.has('工作/开发'));
});

test('更新：仅 name/catelog 对齐，本地属性保留', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', name: '旧名', url: 'https://a.example.com/x', catelog: '旧分类', visibility: 'private', sort_order: 5, hits: 42 });
  const result = await syncBookmarks(m.env, [
    { id: 'c1', title: '新名', url: 'https://a.example.com/x', folderPath: '新分类' },
  ]);
  assert.equal(result.stats.updated, 1);
  const site = m.sites.get(1);
  assert.equal(site.name, '新名');
  assert.equal(site.catelog, '新分类');
  assert.equal(site.url, 'https://a.example.com/x');
  assert.equal(site.visibility, 'private');
  assert.equal(site.sort_order, 5);
  assert.equal(site.hits, 42);
});

test('ID 辅助：URL 被改时原地更新 url 与 url_key', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', browser_bookmark_id: 'c1', name: '书签', url: 'https://a.example.com/old' });
  const result = await syncBookmarks(m.env, [
    { id: 'c1', title: '书签', url: 'https://a.example.com/new', folderPath: '' },
  ]);
  assert.equal(result.stats.updated, 1);
  const site = m.sites.get(1);
  assert.equal(site.url, 'https://a.example.com/new');
  assert.equal(site.url_key, normalizeDuplicateUrlKey('https://a.example.com/new'));
  assert.equal(site.id, 1); // 原地更新，非删旧插新
});

test('手动书签不动，且挡住同名浏览器书签', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'manual', name: '手动书签', url: 'https://manual.example.com/' });
  const result = await syncBookmarks(m.env, [
    { id: 'c1', title: '浏览器里的同URL', url: 'https://manual.example.com/', folderPath: '' },
  ]);
  assert.equal(result.stats.added, 0);
  assert.equal(result.stats.skipped, 1);
  const site = m.sites.get(1);
  assert.equal(site.name, '手动书签');
  assert.equal(site.sync_source, 'manual');
});

test('删除：快照外同步书签被删，且删除前写操作日志', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', browser_bookmark_id: 'c1', name: '保留', url: 'https://keep.example.com/' });
  seedSite(m, 2, { sync_source: 'browser', browser_bookmark_id: 'c2', name: '被删', url: 'https://gone.example.com/' });
  seedSite(m, 3, { sync_source: 'manual', name: '手动保留', url: 'https://manual.example.com/' });
  const result = await syncBookmarks(m.env, [{ id: 'c1', title: '保留', url: 'https://keep.example.com/', folderPath: '' }]);
  assert.equal(result.stats.deleted, 1);
  assert.ok(!m.sites.has(2));
  assert.ok(m.sites.has(3));
  const deleteLog = m.logs.find((l) => l.action === 'sync.bookmark_delete');
  assert.ok(deleteLog, '应写入 sync.bookmark_delete 操作日志');
  assert.equal(deleteLog.detail, JSON.stringify({ url: 'https://gone.example.com/', reason: 'browser snapshot no longer contains this bookmark' }));
});

test('同批重复 URL 只新增一条', async () => {
  const m = createMockEnv();
  const result = await syncBookmarks(m.env, [
    { id: 'c1', title: '重复A', url: 'https://dup.example.com/', folderPath: '' },
    { id: 'c2', title: '重复B', url: 'https://dup.example.com/', folderPath: '' },
  ]);
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.skipped, 1);
});

test('多浏览器 last-write-wins：同 URL 不同 ID 更新同步书签', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', browser_bookmark_id: 'chrome-1', name: 'Chrome标题', url: 'https://shared.example.com/' });
  const result = await syncBookmarks(m.env, [
    { id: 'edge-9', title: 'Edge标题', url: 'https://shared.example.com/', folderPath: '' },
  ]);
  assert.equal(result.stats.updated, 1);
  assert.equal(m.sites.get(1).name, 'Edge标题');
});

test('dryRun 预览：返回差异统计与删除清单，零写入', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', browser_bookmark_id: 'c1', name: '将被删', url: 'https://gone.example.com/' });
  const before = new Map(m.sites);
  const result = await syncBookmarks(m.env, [
    { id: 'c2', title: '新增', url: 'https://new.example.com/', folderPath: '' },
  ], { dryRun: true });
  assert.equal(result.stats.added, 1);
  assert.equal(result.stats.deleted, 1);
  assert.equal(result.deletedItems.length, 1);
  assert.equal(result.deletedItems[0].url, 'https://gone.example.com/');
  assert.deepEqual([...m.sites], [...before]);
  assert.equal(m.logs.filter((l) => l.action === 'sync.bookmark_delete').length, 0);
});

test('unsyncSite：同步书签转手动并清除浏览器 ID', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'browser', browser_bookmark_id: 'c1' });
  const result = await unsyncSite(m.env, 1);
  assert.equal(result.changed, true);
  assert.equal(result.exists, true);
  assert.equal(m.sites.get(1).sync_source, 'manual');
  assert.equal(m.sites.get(1).browser_bookmark_id, null);
});

test('unsyncSite：手动书签为无害空操作，不存在的站点 exists=false', async () => {
  const m = createMockEnv();
  seedSite(m, 1, { sync_source: 'manual' });
  const manual = await unsyncSite(m.env, 1);
  assert.equal(manual.changed, false);
  assert.equal(manual.exists, true);
  assert.equal(m.sites.get(1).sync_source, 'manual');
  const missing = await unsyncSite(m.env, 999);
  assert.equal(missing.exists, false);
});

test('normalizeSyncSnapshot：缺 URL 条目进失败清单，标题回退为 URL', () => {
  const { valid, failed } = normalizeSyncSnapshot([
    { title: '文件夹', url: '' },
    { title: '', url: 'https://no-title.example.com/' },
    { title: '正常', url: 'https://ok.example.com/' },
  ]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason, '缺少 URL');
  assert.equal(valid.length, 2);
  assert.equal(valid[0].title, 'https://no-title.example.com/');
});
