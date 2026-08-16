// API 表面一致性回归锁（2026-08-16 架构评审候选 4）：
// 路由表（ROUTES）与公开发现文档（discovery.js 端点清单）是同一表面的两份实现——
// 新增端点漏写 discovery 会让文档/OpenAPI 静默缺失。本文件锁住危险方向：
// 每个已登记端点（含别名）必须能被路由表匹配。反向（路由表 ⊆ 文档）由人工评审
// 守 public 语义——管理端点不公开，故不做全量断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES } from '../src/handlers/api.js';
import { getPublicApiDiscovery, getPublicOpenApiDocument } from '../src/handlers/api/discovery.js';

// 发现文档路径模板（/api 前缀剥离 + :id 参数）→ 路由表可匹配的样例路径。
function routePathFor(endpointPath) {
  return endpointPath.replace(/^\/api/, '').replace(/:[^/]+/g, '123');
}

test('发现文档：每个已登记端点（含别名）都能被路由表匹配', () => {
  const discovery = getPublicApiDiscovery('https://example.com');
  assert.ok(discovery.endpoints.length > 10, '发现文档应包含全部公开端点');
  for (const endpoint of discovery.endpoints) {
    const path = routePathFor(endpoint.path);
    const matched = ROUTES.some(([match]) => match(path, endpoint.method));
    assert.ok(matched, `发现文档端点 ${endpoint.method} ${endpoint.path} 未在路由表中注册`);
    for (const alias of endpoint.aliases || []) {
      const aliasPath = routePathFor(alias);
      assert.ok(
        ROUTES.some(([match]) => match(aliasPath, endpoint.method)),
        `发现文档别名 ${alias} 未在路由表中注册`,
      );
    }
  }
});

test('发现文档：OpenAPI 由同一端点清单生成（无独立漂移面）', () => {
  const discovery = getPublicApiDiscovery('https://example.com');
  const openapi = getPublicOpenApiDocument('https://example.com');
  const uniquePaths = new Set(discovery.endpoints.map((endpoint) => endpoint.path));
  assert.equal(Object.keys(openapi.paths).length, uniquePaths.size);
  assert.ok(openapi.paths['/api/sites'], 'OpenAPI 应包含 /api/sites');
  assert.ok(openapi.paths['/api/site/:id/ensure-favicon'], 'OpenAPI 应包含参数路径');
});
