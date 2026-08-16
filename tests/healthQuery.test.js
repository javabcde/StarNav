import test from 'node:test';
import assert from 'node:assert/strict';

// 候选 5 拆分：健康谓词单一渲染源 healthQuery 的纯函数测试。
// 断言与拆分前 siteService/systemHealthService 手写 SQL 逐字一致，防止渲染漂移。
import { deadSiteSql, isDeadSite, isOkSite, isUnknownSite, okSiteSql, unknownSiteSql } from '../src/services/healthQuery.js';

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

test('isDeadSite：last_error 非空即 dead，与 deadSiteSql 同义', () => {
  assert.equal(isDeadSite({ last_error: 'HTTP 500', last_status_code: 200 }), true, '错误优先，不看状态码');
  assert.equal(isDeadSite({ last_error: 'HTTP 500', last_status_code: null }), true);
  assert.equal(isDeadSite({ last_error: '', last_status_code: 200 }), false, '空串错误等同无错误（写回时 error||null 归一）');
});

test('isDeadSite：状态码已知且 <200 或 >=400 判定 dead，NULL 状态码不误判', () => {
  assert.equal(isDeadSite({ last_error: null, last_status_code: 404 }), true);
  assert.equal(isDeadSite({ last_error: null, last_status_code: 301 }), false);
  assert.equal(isDeadSite({ last_error: null, last_status_code: 200 }), false);
  // 回归锁：Number(null) 为 0，旧内联副本会把「已检测但无状态码」误判为 dead（SQL 侧有 IS NOT NULL 守卫）
  assert.equal(isDeadSite({ last_error: null, last_status_code: null }), false);
  assert.equal(isDeadSite({ last_error: null }), false);
});

test('isOkSite：无错误且状态码 2xx/3xx，与 okSiteSql 同义', () => {
  assert.equal(isOkSite({ last_error: null, last_status_code: 200 }), true);
  assert.equal(isOkSite({ last_error: null, last_status_code: 301 }), true);
  assert.equal(isOkSite({ last_error: null, last_status_code: 399 }), true);
  assert.equal(isOkSite({ last_error: null, last_status_code: 400 }), false);
  assert.equal(isOkSite({ last_error: 'timeout', last_status_code: 200 }), false);
  assert.equal(isOkSite({ last_error: null, last_status_code: null }), false, 'NULL 状态码不是 ok');
});

test('isUnknownSite：从未检测（last_checked_at 为空），与 unknownSiteSql 同义', () => {
  assert.equal(isUnknownSite({}), true);
  assert.equal(isUnknownSite({ last_checked_at: null }), true);
  assert.equal(isUnknownSite({ last_checked_at: '2026-08-16 10:00:00', last_status_code: null }), false, '已检测但无状态码不是 unknown（gap 态）');
});

test('三态互斥：任意站点记录至多命中一态，gap 态三态皆否', () => {
  const samples = [
    { last_checked_at: '2026-08-16 10:00:00', last_status_code: 200, last_error: null },
    { last_checked_at: '2026-08-16 10:00:00', last_status_code: 500, last_error: 'HTTP 500' },
    { last_checked_at: null, last_status_code: null, last_error: null },
    { last_checked_at: '2026-08-16 10:00:00', last_status_code: null, last_error: null },
  ];
  const states = samples.map((site) => [isDeadSite(site), isOkSite(site), isUnknownSite(site)].filter(Boolean).length);
  assert.deepEqual(states, [1, 1, 1, 0], 'dead/ok/unknown 互斥；已检测无状态码的 gap 态三态皆否（与 SQL 过滤一致）');
});
