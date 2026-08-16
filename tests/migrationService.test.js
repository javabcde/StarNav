import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSchema, resetMigrationStateForTest, SCHEMA_MIGRATION_VERSION } from '../src/services/migrationService.js';

const MIGRATION_VERSION = SCHEMA_MIGRATION_VERSION;
const KV_KEY = 'schema_migration:version';

/**
 * 内存版 env mock：NAV_DB.batch 计数 + NAV_AUTH.kv（可注入 KV get/put 失败）。
 */
function createMockEnv({ marker } = {}) {
  const kv = new Map();
  if (marker !== undefined) kv.set(KV_KEY, marker);

  let batchCalls = 0;
  let getCalls = 0;
  let putCalls = 0;
  let failPut = false;

  const env = {
    NAV_DB: {
      prepare(sql) {
        const stmt = {
          sql,
          bind() { return stmt; },
          async all() { return { results: [] }; },
          async first() { return null; },
          async run() { return { success: true, meta: { changes: 0 } }; },
        };
        return stmt;
      },
      async batch(statements) {
        batchCalls += 1;
        return statements.map(() => ({ success: true, results: [] }));
      },
    },
    NAV_AUTH: {
      async get(key) {
        getCalls += 1;
        const value = kv.get(key);
        return value === undefined ? null : value;
      },
      async put(key, value) {
        putCalls += 1;
        if (failPut) throw new Error('kv unavailable');
        kv.set(key, value);
      },
      async delete() {},
      async list() { return { keys: [], list_complete: true }; },
    },
  };
  return {
    env,
    kv,
    stats: () => ({ batchCalls, getCalls, putCalls }),
    setFailPut: (value) => { failPut = value; },
  };
}

test('无 KV 标记：跑迁移并写标记；同 isolate 后续请求 0 次 KV 读', async () => {
  resetMigrationStateForTest();
  const { env, kv, stats } = createMockEnv({});

  await ensureSchema(env);
  assert.equal(stats().batchCalls, 1, '首次请求必须执行迁移');
  assert.equal(stats().putCalls, 1, '迁移成功后写版本标记');
  assert.equal(kv.get(KV_KEY), MIGRATION_VERSION, '标记值必须等于当前版本');

  const getCallsBefore = stats().getCalls;
  await ensureSchema(env);
  assert.equal(stats().getCalls - getCallsBefore, 0, '同 isolate 二次调用应命中内存状态，不再读 KV');
});

test('KV 标记命中：跳过迁移（0 次 batch）', async () => {
  resetMigrationStateForTest();
  const { env, stats } = createMockEnv({ marker: MIGRATION_VERSION });

  await ensureSchema(env);
  assert.equal(stats().batchCalls, 0);
  assert.equal(stats().putCalls, 0);
});

test('KV 标记落后：补跑并升级标记', async () => {
  resetMigrationStateForTest();
  const { env, kv, stats } = createMockEnv({ marker: '0' });

  await ensureSchema(env);
  assert.equal(stats().batchCalls, 1);
  assert.equal(kv.get(KV_KEY), MIGRATION_VERSION);
});

test('KV 写标记失败：状态回 pending，下次请求重试', async () => {
  resetMigrationStateForTest();
  const { env, kv, stats, setFailPut } = createMockEnv({});

  setFailPut(true);
  await assert.rejects(() => ensureSchema(env));
  assert.equal(stats().batchCalls, 1, '迁移已执行');

  setFailPut(false);
  await ensureSchema(env);
  assert.equal(stats().batchCalls, 2, '状态回 pending 后应重跑迁移');
  assert.equal(kv.get(KV_KEY), MIGRATION_VERSION, '重试成功后补写标记');
});
