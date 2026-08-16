import test from 'node:test';
import assert from 'node:assert/strict';

// 候选 5 拆分的最小行为测试：导入/导出簇已迁入 transferService，
// 这里刻意仍从 siteService 垫片 import，证明存量 import 面的调用链不因拆分断掉。
import { exportConfig, importSites } from '../src/services/siteService.js';
import * as transferService from '../src/services/transferService.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    },
  };
}

function createMockEnv({ existingUrls = [], exportSiteRows = [], exportCategoryRows = [] } = {}) {
  const sitesInserts = [];
  const logInserts = [];
  let nextSiteId = 100;

  function createStatement(sql, binds) {
    return {
      async all() {
        if (sql.includes('SELECT url FROM sites')) return { results: existingUrls.map((url) => ({ url })) };
        if (sql.includes('FROM categories')) return { results: exportCategoryRows };
        if (sql.includes('FROM site_tags st')) return { results: [] };
        if (sql.includes('FROM sites s')) return { results: exportSiteRows };
        return { results: [] };
      },
      async first() {
        if (sql.includes('FROM categories')) return { id: 5, name: '工具' };
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO sites')) {
          sitesInserts.push({ sql, binds });
          return { success: true, meta: { changes: 1, last_row_id: nextSiteId } };
        }
        if (sql.includes('INSERT INTO operation_logs')) {
          logInserts.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
      binds,
    };
  }

  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind: (...binds) => createStatement(sql, binds),
          all: () => createStatement(sql, []).all(),
          first: () => createStatement(sql, []).first(),
          run: () => createStatement(sql, []).run(),
        };
      },
      async batch(statements) {
        return (statements || []).map(() => ({ success: true }));
      },
    },
    sitesInserts,
    logInserts,
  };
}

test('siteService 垫片与 transferService 导出同一实现（re-export 链路）', () => {
  assert.equal(importSites, transferService.importSites);
  assert.equal(exportConfig, transferService.exportConfig);
});

test('importSites：merge 模式跳过已存在去重键并记录 site.import 操作日志', async () => {
  const payload = {
    sites: [
      { name: '示例站', url: 'https://example.com/', catelog: '工具', tags: ['效率'] },
      { name: '重复站', url: 'https://dup.test', catelog: '工具' },
    ],
    categories: [],
  };
  const env = createMockEnv({ existingUrls: ['https://dup.test'] });
  const imported = await importSites(env, payload, { mode: 'merge', ip: '1.2.3.4' });

  assert.equal(imported, 1, '已存在去重键的书签应被跳过，仅导入 1 条');
  assert.equal(env.sitesInserts.length, 1, '应恰好插入一条 sites 记录');
  assert.equal(env.sitesInserts[0].binds[0], '示例站', '站点名称应写入');
  assert.equal(env.sitesInserts[0].binds[9], 'example.com/', 'url_key 应为去重键');
  assert.equal(env.logInserts.length, 1, '应记录一条操作日志');
  assert.equal(env.logInserts[0].binds[0], 'site.import', '日志动作应为 site.import');
  assert.equal(env.logInserts[0].binds[3], 'merge 导入 1 个书签', '日志摘要应为 merge 导入 1 个书签');
});

test('exportConfig：导出全部站点与分类（管理员上下文全量）', async () => {
  const env = createMockEnv({
    exportSiteRows: [{ id: 1, name: '站点A', url: 'https://a.test', catelog: '工具' }],
    exportCategoryRows: [{ id: 5, name: '工具', parent_id: null, sort_order: 9999, icon: null, description: null }],
  });
  const config = await exportConfig(env);

  assert.equal(config.sites.length, 1, '应导出全部站点');
  assert.equal(config.sites[0].name, '站点A');
  assert.deepEqual(config.sites[0].tags, [], '导出站点应附带空标签数组');
  assert.equal(config.categories.length, 1, '应导出分类');
  assert.equal(config.categories[0].name, '工具');
});
