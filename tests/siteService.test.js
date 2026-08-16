import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canAccessSite,
  canListSite,
  getSites,
  listSitesByIds,
  normalizeDuplicateUrlKey,
  normalizeImportPayload,
  previewImportSites,
  searchSites,

} from '../src/services/siteService.js';


test('getSites：space 按名称过滤经 resolveSpaceId 解析（回归锁：评审 Critical——导入面被误删曾致 500）', async () => {
  const env = createMockEnv({
    sites: [{ id: 1, name: '甲', url: 'https://a.example.com', catelog: '工具', visibility: 'public' }],
    spaces: [{ id: 7, slug: 'work', name: '工作空间' }],
  });

  const result = await getSites(env, { space: 'work' });

  assert.equal(result.total, 1, '按名过滤应解析到空间并正常返回，而非 ReferenceError');
  assert.equal(result.data[0].name, '甲');
});
import { ensureSiteFavicon, faviconFailedKey } from '../src/services/iconService.js';

function createMockEnv({ sites = [], tagRows = [], existingCategories = [], existingUrls = [], spaces = [] } = {}) {
  return {
    NAV_DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return createStatement(sql, binds);
          },
          all() {
            return createStatement(sql, []).all();
          },
          first() {
            return createStatement(sql, []).first();
          },
          run() {
            return createStatement(sql, []).run();
          },
        };
      },
    },
  };

  function createStatement(sql, binds) {
    function findSpaceRow() {
      const bySlug = sql.includes('WHERE slug =');
      return spaces.find((sp) => (bySlug ? sp.slug === binds[0] : sp.id === Number(binds[0])));
    }
    return {
      async all() {
        if (sql.includes('FROM site_tags st') && sql.includes('JOIN tags t')) {
          return { results: tagRows };
        }

        if (sql.includes('SELECT name FROM categories')) {
          return { results: existingCategories.map((name) => ({ name })) };
        }

        if (sql.includes('SELECT url FROM sites')) {
          return { results: existingUrls.map((url) => ({ url })) };
        }

        if (sql.includes('FROM sites s')) {
          // listSitesByIds 的按 ID 查询：模拟 SQL 层的可见性 WHERE 过滤。
          if (sql.includes('WHERE s.id IN')) {
            const ids = new Set(binds.filter((b) => typeof b === 'number').map(Number));
            let rows = sites.filter((s) => ids.has(Number(s.id)));
            if (sql.includes("COALESCE(s.visibility, 'public') IN ('public', 'private')")) {
              rows = rows.filter((s) => ['public', 'private'].includes(s.visibility));
            } else if (sql.includes("COALESCE(s.visibility, 'public') = 'public'")) {
              rows = rows.filter((s) => s.visibility === 'public');
            }
            return { results: rows };
          }
          return { results: sites };
        }

        return { results: [] };
      },
      async first() {
        if (sql.includes('FROM spaces')) {
          const row = findSpaceRow();
          return row ? { ...row } : null;
        }
        if (sql.includes('COUNT(*)') && sql.includes('FROM sites')) {
          return { total: sites.length };
        }
        return null;
      },
      async run() {
        return { success: true, meta: { changes: 1 } };
      },
      binds,
    };
  }
}

test('normalizeDuplicateUrlKey treats protocol, www and trailing slash as equivalent', () => {
  assert.equal(normalizeDuplicateUrlKey('https://www.example.com/path/'), 'example.com/path');
  assert.equal(normalizeDuplicateUrlKey('http://example.com/path'), 'example.com/path');
  assert.equal(normalizeDuplicateUrlKey('example.com/path/'), 'example.com/path');
  assert.equal(normalizeDuplicateUrlKey('https://example.com/path/?q=1'), 'example.com/path?q=1');
});

test('visibility helpers enforce public, private, unlisted and admin-only rules', () => {
  const publicSite = { visibility: 'public', catelog: '工具' };
  const privateSite = { visibility: 'private', catelog: '私人' };
  const unlistedSite = { visibility: 'unlisted', catelog: '工具' };
  const adminOnlySite = { visibility: 'admin_only', catelog: '工具' };

  assert.equal(canAccessSite(publicSite), true);
  assert.equal(canListSite(publicSite), true);

  assert.equal(canAccessSite(privateSite), false);
  assert.equal(canListSite(privateSite), false);
  assert.equal(canAccessSite(privateSite, { privateUnlocked: true }), true);
  assert.equal(canListSite(privateSite, { privateUnlocked: true }), true);

  assert.equal(canAccessSite(unlistedSite), true);
  assert.equal(canListSite(unlistedSite), false);

  assert.equal(canAccessSite(adminOnlySite), false);
  assert.equal(canListSite(adminOnlySite), false);
  assert.equal(canAccessSite(adminOnlySite, { adminAuthed: true }), true);
  assert.equal(canListSite(adminOnlySite, { adminAuthed: true }), true);
});

test('normalizeImportPayload accepts legacy array and structured export formats', () => {
  const legacy = [{ name: 'A', url: 'https://a.test', catelog: '工具' }];
  assert.deepEqual(normalizeImportPayload(legacy), { sites: legacy, categories: [] });

  const structured = {
    sites: legacy,
    categories: [{ name: '工具' }],
  };
  assert.deepEqual(normalizeImportPayload(structured), structured);

  const dataWrapper = {
    data: legacy,
    categories: [{ name: '工具' }],
  };
  assert.deepEqual(normalizeImportPayload(dataWrapper), {
    sites: legacy,
    categories: dataWrapper.categories,
  });

  assert.throws(() => normalizeImportPayload({ invalid: true }), /Invalid JSON data/);
});

test('previewImportSites reports invalid rows, duplicate rows and missing categories', async () => {
  const env = createMockEnv({
    existingCategories: ['工具'],
    existingUrls: ['https://already.example.com'],
  });

  const preview = await previewImportSites(env, [
    { name: '有效站点', url: 'https://new.example.com', catelog: '工具' },
    { name: '缺少分类', url: 'https://invalid.example.com' },
    { name: '已有站点', url: 'http://www.already.example.com/', catelog: '工具' },
    { name: '文件内重复 1', url: 'https://dup.example.com/path/', catelog: '新分类' },
    { name: '文件内重复 2', url: 'http://www.dup.example.com/path', catelog: '新分类' },
  ]);

  assert.equal(preview.totalSites, 5);
  assert.equal(preview.validSites, 2);
  assert.equal(preview.invalidSites, 1);
  assert.equal(preview.duplicateExisting, 1);
  assert.equal(preview.duplicateInFile, 1);
  assert.deepEqual(preview.missingCategories, ['新分类']);
  assert.deepEqual(preview.willCreateCategories, ['新分类']);
});

test('searchSites gives exact name matches higher rank and exposes match reasons', async () => {
  const now = new Date().toISOString();
  const env = createMockEnv({
    sites: [
      {
        id: 1,
        name: '普通图床工具',
        url: 'https://image.example.com',
        desc: '星空图床替代工具',
        catelog: '工具',
        visibility: 'public',
        hits: 10,
        create_time: now,
        update_time: now,
      },
      {
        id: 2,
        name: '星空图床',
        url: 'https://xktc.example.com',
        desc: '图片上传外链',
        catelog: '图床',
        visibility: 'public',
        hits: 0,
        create_time: now,
        update_time: now,
      },
    ],
    tagRows: [
      { site_id: 1, name: '图床' },
      { site_id: 2, name: '图片' },
    ],
  });

  const results = await searchSites(env, { keyword: '星空图床', limit: 5 });

  assert.equal(results.length, 2);
  assert.equal(results[0].name, '星空图床');
  assert.ok(results[0]._score > results[1]._score);
  assert.ok(results[0]._matchedFields.includes('name'));
  assert.ok(results[0]._matchReasons.some((reason) => reason.includes('名称完全匹配')));
});

test('searchSites supports advanced tag filter syntax', async () => {
  const now = new Date().toISOString();
  const env = createMockEnv({
    sites: [
      {
        id: 1,
        name: 'AI 工具箱',
        url: 'https://ai.example.com',
        desc: '人工智能工具',
        catelog: 'AI',
        visibility: 'public',
        create_time: now,
        update_time: now,
      },
      {
        id: 2,
        name: '图床工具',
        url: 'https://img.example.com',
        desc: '图片上传',
        catelog: '工具',
        visibility: 'public',
        create_time: now,
        update_time: now,
      },
    ],
    tagRows: [
      { site_id: 1, name: 'AI' },
      { site_id: 2, name: '图床' },
    ],
  });

  const results = await searchSites(env, { keyword: 'tag:图床', limit: 5 });

  assert.deepEqual(results.map((site) => site.name), ['图床工具']);
});
test('listSitesByIds 按可见性过滤：匿名只见 public、私密解锁见 public+private、admin 全见', async () => {
  const sites = [
    { id: 1, name: '公开站', url: 'https://a.test', catelog: '工具', visibility: 'public' },
    { id: 2, name: '私密站', url: 'https://b.test', catelog: '私人书签', visibility: 'private' },
    { id: 3, name: '内部站', url: 'https://c.test', catelog: '工具', visibility: 'admin_only' },
  ];
  const env = createMockEnv({ sites });

  const anon = await listSitesByIds(env, [1, 2, 3, 99]);
  assert.deepEqual(anon.map((s) => s.id), [1], '匿名只能拿到 public');

  const unlocked = await listSitesByIds(env, [1, 2, 3], { includePrivate: true, privateUnlocked: true });
  assert.deepEqual(unlocked.map((s) => s.id).sort(), [1, 2], '私密解锁可拿 public + private');

  const admin = await listSitesByIds(env, [1, 2, 3], { adminAuthed: true });
  assert.deepEqual(admin.map((s) => s.id).sort(), [1, 2, 3], 'admin 全可见');
});

test('listSitesByIds 清洗 id：NaN/负数/空字符串/重复被剔除，空数组直接返回', async () => {
  const sites = [
    { id: 1, name: '公开站', url: 'https://a.test', catelog: '工具', visibility: 'public' },
    { id: 2, name: '另一站', url: 'https://b.test', catelog: '工具', visibility: 'public' },
  ];
  const env = createMockEnv({ sites });

  const cleaned = await listSitesByIds(env, [1, 'abc', -5, 0, 1, '']);
  assert.deepEqual(cleaned.map((s) => s.id), [1], 'NaN/负数/0/重复应被清洗，仅剩去重后的有效 id');

  assert.deepEqual(await listSitesByIds(env, []), []);
  assert.deepEqual(await listSitesByIds(env, ['x', -1]), []);
});

// ===== ensureSiteFavicon（图标自动补全）=====

function createFaviconEnv({ kv } = {}) {
  const kvStore = kv || new Map();
  return {
    NAV_AUTH: {
      async get(key) {
        return kvStore.has(key) ? kvStore.get(key) : null;
      },
      async put(key, value) {
        kvStore.set(key, String(value));
      },
      async delete(key) {
        kvStore.delete(key);
      },
    },
    NAV_DB: {
      prepare() {
        return {
          bind() {
            return {
              async run() {
                return { success: true };
              },
            };
          },
        };
      },
    },
  };
}

test('ensureSiteFavicon：已有 logo 直接跳过，不抓取不写标记，返回现有 URL', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const kv = new Map();
  const result = await ensureSiteFavicon(createFaviconEnv({ kv }), { id: 1, logo: 'https://i/x.png', url: 'https://example.test' });
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'has-logo');
  assert.equal(result.favicon, 'https://i/x.png', '应返回现有 logo，供插件本地 patch');
  assert.equal(fetchMock.mock.callCount(), 0, '不应发起任何抓取请求');
  assert.equal(kv.has(faviconFailedKey(1)), false, '不应写失败标记');
});

test('ensureSiteFavicon：抓取成功写回 logo，不写失败标记', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }));
  const kv = new Map();
  const result = await ensureSiteFavicon(createFaviconEnv({ kv }), { id: 2, logo: '', url: 'https://example.test' });
  assert.equal(result.updated, true);
  assert.equal(result.reason, 'filled');
  assert.match(result.favicon, /^https:\/\//, '成功应返回图标 URL');
  assert.equal(fetchMock.mock.callCount(), 1, '第一个源命中即停止');
  assert.equal(kv.has(faviconFailedKey(2)), false);
});

test('ensureSiteFavicon：5 源全失败写入永久失败标记（no-favicon）', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('x', { status: 404 }));
  const kv = new Map();
  const result = await ensureSiteFavicon(createFaviconEnv({ kv }), { id: 3, logo: '', url: 'https://example.test' });
  assert.deepEqual(result, { updated: false, reason: 'no-favicon' });
  assert.equal(fetchMock.mock.callCount(), 6, '5 个聚合源 + 源站 HTML 全部尝试后放弃');
  assert.equal(kv.get(faviconFailedKey(3)), '1', '失败标记应为永久值');
});

test('ensureSiteFavicon：已标记失败的站点跳过，不再抓取', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('should not fetch');
  });
  const kv = new Map([[faviconFailedKey(4), '1']]);
  const result = await ensureSiteFavicon(createFaviconEnv({ kv }), { id: 4, logo: '', url: 'https://example.test' });
  assert.deepEqual(result, { updated: false, reason: 'already-failed' });
  assert.equal(fetchMock.mock.callCount(), 0, '不应发起任何抓取请求');
});
