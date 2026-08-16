// 迁移单一源回归锁（架构评审候选 7）：schema.sql 必须由 migrationService 生成，
// 且生成物 == 提交文件（规范化比较）。防单边漂移：
//  - 手改 schema.sql → 与 getFreshSchemaSql() 不一致 → 提示改 migrationService 后重新生成；
//  - 改 migrationService 忘跑 npm run schema:generate → 提交文件过期 → 同样失败。
// 另锁 fresh schema 完整性：11 张表、全部 ensureColumn 并入、15 条索引齐备。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getFreshSchemaSql } from '../src/services/migrationService.js';

function normalizeSql(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('--'))
    .join('\n');
}

test('生成物与提交的 schema.sql 一致（改定义后须运行 npm run schema:generate）', () => {
  const generated = normalizeSql(getFreshSchemaSql());
  const committed = normalizeSql(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  assert.equal(generated, committed, 'schema.sql 与 migrationService 单一源不一致——请运行 npm run schema:generate');
});

test('fresh schema 完整性：11 张表全部生成', () => {
  const sql = getFreshSchemaSql();
  const tables = [...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.deepEqual(
    [...tables].sort(),
    ['categories', 'category_metadata', 'category_orders', 'operation_logs', 'pending_sites', 'search_terms', 'settings', 'site_tags', 'sites', 'spaces', 'tags'].sort(),
  );
});

test('fresh schema 完整性：ensureColumn 清单并入 CREATE（sites/pending_sites 增列在列）', () => {
  const sql = getFreshSchemaSql();
  const sitesBlock = sql.match(/CREATE TABLE IF NOT EXISTS sites \([\s\S]*?\);/)[0];
  for (const column of ['url_key', 'sync_source', "browser_bookmark_id", 'category_id', 'space_id']) {
    assert.ok(sitesBlock.includes(`${column} `), `sites 应含 ${column}`);
  }
  const pendingBlock = sql.match(/CREATE TABLE IF NOT EXISTS pending_sites \([\s\S]*?\);/)[0];
  for (const column of ['tags', 'reason', 'status', 'reject_reason', 'reviewed_at']) {
    assert.ok(pendingBlock.includes(`${column} `), `pending_sites 应含 ${column}`);
  }
  const categoriesBlock = sql.match(/CREATE TABLE IF NOT EXISTS categories \([\s\S]*?\);/)[0];
  for (const column of ['parent_id', 'space_id', 'icon', 'color']) {
    assert.ok(categoriesBlock.includes(`${column} `), `categories 应含 ${column}`);
  }
});

test('fresh schema 完整性：15 条索引齐备（含 idx_sites_sync_source / idx_sites_category）', () => {
  const sql = getFreshSchemaSql();
  const indexes = [...sql.matchAll(/CREATE INDEX IF NOT EXISTS (\w+)/g)].map((m) => m[1]);
  assert.equal(indexes.length, 15);
  assert.ok(indexes.includes('idx_sites_sync_source'), '同步书签索引应在列');
  assert.ok(indexes.includes('idx_sites_category'), 'category_id 索引应在列');
});
