// getPendingSites 三层回退梯测试（2026-08-16 架构评审候选 6）：
// 主查询 → legacy 降级（仅 pending 状态）→ emptyResult；分页参数钳制一并锁定。
import test from 'node:test';
import assert from 'node:assert/strict';
import { getPendingSites } from '../src/services/submissionService.js';

function createPendingEnv({ failPrimary = false, failLegacy = false } = {}) {
  const binds = [];
  const db = {
    prepare(sql) {
      const first = async () => {
        if (sql.includes('SUM(CASE')) return { pending_count: 3, approved_count: 1, rejected_count: 1 };
        if (sql.includes('WHERE COALESCE(status')) return { total: 5 };
        if (sql.includes('SELECT COUNT(*) AS total FROM pending_sites')) return { total: 5 };
        return null;
      };
      const all = async () => {
        if (sql.includes('SELECT * FROM pending_sites')) {
          if (failPrimary) throw new Error('primary boom');
          return { results: [{ id: 1, name: 'A', tags: '["x"]' }, { id: 2, name: 'B', tags: 'x, y' }] };
        }
        if (sql.includes('SELECT id, name, url, logo, desc, catelog, create_time')) {
          if (failLegacy) throw new Error('legacy boom');
          return { results: [{ id: 9, name: 'L' }] };
        }
        return { results: [] };
      };
      return {
        bind: (...args) => {
          binds.push({ sql, args });
          return { first, all, run: async () => ({}) };
        },
        // legacy 计数查询直接 prepare().first()（无 bind），prepare 结果须暴露 first
        first,
        all,
      };
    },
  };
  return { NAV_DB: db, binds };
}

test('第一层：主查询成功——标签解析、总量、统计、分页参数入绑', async () => {
  const env = createPendingEnv();
  const result = await getPendingSites(env, { page: 3, pageSize: 20 });

  assert.deepEqual(result.data[0].tags, ['x']);
  assert.deepEqual(result.data[1].tags, ['x', 'y']);
  assert.equal(result.total, 5);
  assert.equal(result.page, 3);
  assert.equal(result.pageSize, 20);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.stats, { pending: 3, approved: 1, rejected: 1 });

  const listBind = env.binds.find((b) => b.sql.includes('SELECT * FROM pending_sites'));
  assert.deepEqual(listBind.args, ['pending', 20, 40], 'LIMIT/OFFSET 应按 (page-1)*pageSize 计算');
});

test('第二层：主查询抛错且状态为 pending——legacy 降级列集与计数兜底', async () => {
  const env = createPendingEnv({ failPrimary: true });
  const result = await getPendingSites(env, { page: 1, pageSize: 10 });

  assert.equal(result.data.length, 1);
  assert.equal(result.data[0].id, 9);
  assert.equal(result.data[0].status, 'pending');
  assert.deepEqual(result.data[0].tags, []);
  assert.equal(result.total, 5);
  assert.deepEqual(result.stats, { pending: 5, approved: 0, rejected: 0 });
});

test('第二层跳过：主查询抛错且状态非 pending——直接 emptyResult 不进 legacy', async () => {
  const env = createPendingEnv({ failPrimary: true, failLegacy: true });
  const result = await getPendingSites(env, { status: 'approved' });

  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
  assert.equal(result.status, 'approved');
  assert.deepEqual(result.stats, { pending: 0, approved: 0, rejected: 0 });
});

test('第三层：主查询与 legacy 均抛错——emptyResult 不向上抛', async () => {
  const env = createPendingEnv({ failPrimary: true, failLegacy: true });
  const result = await getPendingSites(env, { page: 1, pageSize: 10 });

  assert.deepEqual(result.data, []);
  assert.equal(result.total, 0);
  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 10);
});

test('参数钳制：page 下限 1、pageSize 上限 100、非法状态回退 pending', async () => {
  const env = createPendingEnv();
  const result = await getPendingSites(env, { page: 0, pageSize: 500, status: 'bogus' });

  assert.equal(result.page, 1);
  assert.equal(result.pageSize, 100);
  assert.equal(result.status, 'pending');
  const listBind = env.binds.find((b) => b.sql.includes('SELECT * FROM pending_sites'));
  assert.deepEqual(listBind.args, ['pending', 100, 0]);
});
