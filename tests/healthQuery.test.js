import test from 'node:test';
import assert from 'node:assert/strict';

// 候选 5 拆分：健康谓词单一渲染源 healthQuery 的纯函数测试。
// 断言与拆分前 siteService/systemHealthService 手写 SQL 逐字一致，防止渲染漂移。
import { deadSiteSql, okSiteSql, unknownSiteSql } from '../src/services/healthQuery.js';

test('deadSiteSql：last_error 非空，或状态码已知且 <200 或 >=400（带表别名）', () => {
  assert.equal(
    deadSiteSql('s'),
    '(s.last_error IS NOT NULL OR (s.last_status_code IS NOT NULL AND (s.last_status_code < 200 OR s.last_status_code >= 400)))',
  );
});

test('deadSiteSql：空别名渲染裸列名（无别名的整表 count 场景）', () => {
  assert.equal(
    deadSiteSql(),
    '(last_error IS NOT NULL OR (last_status_code IS NOT NULL AND (last_status_code < 200 OR last_status_code >= 400)))',
  );
});

test('okSiteSql：无错误且状态码为 2xx/3xx（带表别名）', () => {
  assert.equal(
    okSiteSql('s'),
    '(s.last_error IS NULL AND s.last_status_code >= 200 AND s.last_status_code < 400)',
  );
});

test('okSiteSql：空别名渲染裸列名', () => {
  assert.equal(
    okSiteSql(),
    '(last_error IS NULL AND last_status_code >= 200 AND last_status_code < 400)',
  );
});

test('unknownSiteSql：从未检测（last_checked_at 为空）', () => {
  assert.equal(unknownSiteSql('s'), 's.last_checked_at IS NULL');
  assert.equal(unknownSiteSql(), 'last_checked_at IS NULL');
});
