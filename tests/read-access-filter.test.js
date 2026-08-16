import test from 'node:test';
import assert from 'node:assert/strict';

import { getAllSites, getSiteAnalytics } from '../src/services/siteService.js';
import { chatWithAiAssistant } from '../src/services/aiService.js';
import { canListSite } from '../src/services/accessService.js';

// 与 siteService.test.js 同模式：D1 mock 按 SQL 子串分发。
// 本文件只新增测试（read-access-consolidation），不改动任何存量测试文件。
const SITES = [
  { id: 1, name: '公开工具', url: 'https://a.com', catelog: '工具', visibility: 'public', hits: 10, last_visit_time: '2026-08-01 00:00:00', logo: '' },
  { id: 2, name: '私密站点', url: 'https://b.com', catelog: '私人', visibility: 'private', hits: 20, last_visit_time: '2026-08-01 00:00:00', logo: '' },
  { id: 3, name: '隐藏站点', url: 'https://c.com', catelog: '工具', visibility: 'unlisted', hits: 30, logo: '' },
  { id: 4, name: '仅管理员', url: 'https://d.com', catelog: '工具', visibility: 'admin_only', hits: 40, logo: '' },
  { id: 5, name: '私密分类公开', url: 'https://e.com', catelog: '私人书签', visibility: 'public', hits: 50, logo: '' },
];

function filterByVisibility(sql, binds, rows) {
  if (sql.includes("COALESCE(s.visibility, 'public') IN ('public', 'private')")) {
    return rows.filter((s) => ['public', 'private'].includes(s.visibility));
  }
  if (sql.includes("COALESCE(s.visibility, 'public') = 'public'")) {
    const privateCategory = binds[0]; // 匿名分支的第一个绑定即 PRIVATE_BOOKMARK_CATEGORY
    return rows.filter((s) => s.visibility === 'public' && s.catelog !== privateCategory);
  }
  return rows;
}

function createMockEnv({ sites = [], tagRows = [] } = {}) {
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
    return {
      async all() {
        if (sql.includes('FROM site_tags st') && sql.includes('JOIN tags t')) {
          return { results: tagRows };
        }
        if (sql.includes('FROM sites s')) {
          let rows = sites;
          if (sql.includes('WHERE s.id IN')) {
            const ids = new Set(binds.filter((b) => typeof b === 'number').map(Number));
            rows = rows.filter((s) => ids.has(Number(s.id)));
          }
          rows = filterByVisibility(sql, binds, rows);
          return { results: rows };
        }
        return { results: [] };
      },
      async first() {
        // 汇总查询（totals）：与可见性无关的聚合统计
        if (sql.includes('COUNT(*) AS total_sites')) {
          return { total_sites: sites.length, total_hits: 0, never_visited: 0, stale_30d: 0 };
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

const ids = (rows) => rows.map((s) => Number(s.id)).sort((a, b) => a - b);

test('getSiteAnalytics：匿名仅 public + 非私密分类（三查询统一过滤）', async () => {
  const env = createMockEnv({ sites: SITES });
  const analytics = await getSiteAnalytics(env, { limit: 20 });
  assert.deepEqual(ids(analytics.topByHits), [1]);
  assert.deepEqual(ids(analytics.recentlyActive), [1]);
  assert.deepEqual(ids(analytics.inactiveSites), [1]);
});

test('getSiteAnalytics：privateUnlocked 含 private（token 即密码级凭据，ADR-0002）', async () => {
  const env = createMockEnv({ sites: SITES });
  const analytics = await getSiteAnalytics(env, { limit: 20, access: { adminAuthed: false, privateUnlocked: true } });
  assert.deepEqual(ids(analytics.topByHits), [1, 2, 5]);
});

test('getSiteAnalytics：管理员全可见', async () => {
  const env = createMockEnv({ sites: SITES });
  const analytics = await getSiteAnalytics(env, { limit: 20, access: { adminAuthed: true, privateUnlocked: true } });
  assert.deepEqual(ids(analytics.topByHits), [1, 2, 3, 4, 5]);
});

test('chat 排行泄露回归：匿名 chat 排行意图不返回非公开站点', async () => {
  const env = createMockEnv({ sites: SITES });
  const result = await chatWithAiAssistant(env, {}, {
    message: '访问最多的书签有哪些',
    previousSites: [],
    access: { adminAuthed: false, privateUnlocked: false },
  });
  assert.equal(result.code, 200);
  const returned = Array.isArray(result.data.sites) ? result.data.sites : [];
  assert.ok(returned.length > 0, '排行应返回公开站点');
  // analytics 映射层不携带 visibility 字段，按 id 集合断言（等价于 canListSite 匿名集合）
  assert.deepEqual(ids(returned), [1]);
  for (const site of returned) {
    assert.notEqual(site.catelog, '私人书签', '不得泄露私密分类站点');
  }
});

test('chat 排行泄露回归：解锁上下文可含 private（与 searchSites 同语义）', async () => {
  const env = createMockEnv({ sites: SITES });
  const result = await chatWithAiAssistant(env, {}, {
    message: '访问最多的书签有哪些',
    previousSites: [],
    access: { adminAuthed: false, privateUnlocked: true },
  });
  const returned = Array.isArray(result.data.sites) ? result.data.sites : [];
  assert.deepEqual(ids(returned), [1, 2, 5]);
});


test('home 可见性等价性：getAllSites SQL 过滤与 canListSite 谓词三态一致', async () => {
  const env = createMockEnv({ sites: SITES });
  const cases = [
    ['匿名', { adminAuthed: false, privateUnlocked: false }],
    ['解锁', { adminAuthed: false, privateUnlocked: true }],
    ['管理员', { adminAuthed: true, privateUnlocked: true }],
  ];
  for (const [label, access] of cases) {
    const viaSql = ids(await getAllSites(env, { access }));
    const viaPredicate = ids(SITES.filter((s) => canListSite(s, access)));
    assert.deepEqual(viaSql, viaPredicate, `${label}：SQL 过滤必须与 canListSite 一致`);
  }
});
