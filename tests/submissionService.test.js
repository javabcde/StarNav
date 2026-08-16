import test from 'node:test';
import assert from 'node:assert/strict';

// 候选 5 拆分的最小行为测试：投稿审核簇已迁入 submissionService（pending_sites 表），
// 这里刻意仍从 siteService 垫片 import，证明存量 import 面的调用链不因拆分断掉。
import { approvePendingSite } from '../src/services/siteService.js';
import * as submissionService from '../src/services/submissionService.js';

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

function createMockEnv({ pendingRow = null, duplicateRow = null } = {}) {
  const sitesInserts = [];
  const pendingUpdates = [];
  const logInserts = [];
  let nextSiteId = 42;

  function createStatement(sql, binds) {
    return {
      async all() {
        return { results: [] };
      },
      async first() {
        if (sql.includes('FROM pending_sites')) return pendingRow ? { ...pendingRow } : null;
        if (sql.includes('url_key')) return duplicateRow;
        if (sql.includes('FROM categories')) return { id: 5, name: '工具' };
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO sites')) {
          sitesInserts.push({ sql, binds });
          return { success: true, meta: { changes: 1, last_row_id: nextSiteId } };
        }
        if (sql.includes('UPDATE pending_sites')) {
          pendingUpdates.push({ sql, binds });
          return { success: true, meta: { changes: 1 } };
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
    pendingUpdates,
    logInserts,
  };
}

test('siteService 垫片与 submissionService 导出同一实现（re-export 链路）', () => {
  assert.equal(approvePendingSite, submissionService.approvePendingSite);
});

test('approvePendingSite：写入 sites、置 approved 并记录 pending.approve 操作日志', async () => {
  const pendingRow = {
    id: 9,
    name: '示例站',
    url: 'https://example.com/',
    logo: null,
    desc: '描述',
    catelog: '工具',
    tags: '["效率"]',
    status: null,
  };
  const env = createMockEnv({ pendingRow });
  await approvePendingSite(env, 9, { ip: '1.2.3.4' });

  // 1) 站点落库：url_key 走去重键规范化（去协议与尾斜杠），可见性缺省 public
  assert.equal(env.sitesInserts.length, 1, '应恰好插入一条 sites 记录');
  assert.equal(env.sitesInserts[0].binds[0], '示例站', '站点名称应写入');
  assert.equal(env.sitesInserts[0].binds[1], 'https://example.com/', '站点 URL 应原样写入');
  assert.equal(env.sitesInserts[0].binds[4], '工具', '分类名称应写入');
  assert.equal(env.sitesInserts[0].binds[7], 'public', '缺省可见性应为 public');
  assert.equal(env.sitesInserts[0].binds[9], 'example.com/', 'url_key 应为去重键');

  // 2) 投稿状态置 approved
  assert.equal(env.pendingUpdates.length, 1, '应更新 pending_sites 状态');
  assert.match(env.pendingUpdates[0].sql, /status = 'approved'/, '状态应更新为 approved');
  assert.equal(env.pendingUpdates[0].binds[0], 9, '应按投稿 ID 更新');

  // 3) operation_logs 随迁记录（ADR-0004：写服务内部记录）
  assert.equal(env.logInserts.length, 1, '应记录一条操作日志');
  assert.equal(env.logInserts[0].binds[0], 'pending.approve', '日志动作应为 pending.approve');
  assert.equal(env.logInserts[0].binds[5], '1.2.3.4', '日志应携带操作 IP');
});

test('approvePendingSite：URL 与现有书签重复时抛 DUPLICATE_URL 且不落库', async () => {
  const pendingRow = {
    id: 9,
    name: '重复站',
    url: 'https://dup.test',
    logo: null,
    desc: null,
    catelog: '工具',
    tags: null,
    status: null,
  };
  const env = createMockEnv({
    pendingRow,
    duplicateRow: { id: 3, name: '已有站', url: 'https://dup.test', catelog: '工具' },
  });
  await assert.rejects(
    () => approvePendingSite(env, 9),
    (error) => error.code === 'DUPLICATE_URL' && error.scope === 'approve',
  );
  assert.equal(env.sitesInserts.length, 0, '重复时不应写入 sites');
  assert.equal(env.pendingUpdates.length, 0, '重复时不应更新投稿状态');
});
