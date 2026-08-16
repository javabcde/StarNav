## Why

api.js 的 848 行精确路径 if 链（~45 端点）是三批收编波里唯一没被收编的浅模块：~35 处内联 `requireAdmin`、15+ 处手写审计摘要、3 份逐字复制的三段鉴权（`/site/preview` 与 `/submit/suggest-*`）、导出格式协商内联。ADR-0003 明确把路由表列为"重构领地"；同批收编还暴露两处相邻摩擦：

1. **可见性 SQL 六份复制**：`siteService.js` 的 getSites/getAllSites/searchSites/listSitesByIds/搜索回退共 6 处逐字复制同一 2 行谓词（`COALESCE(s.visibility,'public') IN/<> …` + `PRIVATE_BOOKMARK_CATEGORY` 绑定）——ADR-0003 收编了规则本身，SQL 渲染留在原地，改规则要改 6 处且 binds 顺序靠手工对齐。
2. **变更记录 caller-owned**：审计调用散在 handler 每个写分支（手写摘要），同步模块在服务层另调一份——新端点静默漏记、摘要漂移；定时任务等非 HTTP 写路径无记录。

## What Changes

- **表驱动 dispatcher**：`handlers/api.js` 收缩为 `ROUTES` 表（`[match, handler]`，先匹配先得，静态段条目先于参数段），handler 按资源拆进 `handlers/api/resources/{sites,categories,tags,backups,settings,analytics,admin,ai}.js`，签名统一 `(request, env, ctx, path, method, id, url)`，未命中返回 null 落到 404。
- **鉴权随资源模块走**：`/submit/suggest-*` 三段鉴权收编为 `errors.js:requireSubmitter`（管理员 cookie / write token / 投稿开关）。
- **可见性 SQL 单一渲染**：`accessService.visibilityWhere(access)` 返回 `{ sql, binds }`，siteService 六处经本地 `applyVisibilityWhere` 消费；`filters.visibility` 站点筛选与无 join 遗留回退 `s.catelog <> ?` 不属于访问规则，不动。
- **变更记录归服务层**：createSite/updateSite/deleteSite/bulk*/reorder/import/approve/reject/unsync、分类、标签、备份、同步汇总全部移入写服务内部（bookmarkSyncService 本就如此）；`logOperation` 新增可选 `ip` 字段，资源模块每请求提取一次 `clientIpFromRequest(request)` 经服务 options 传入。
- 测试：新增 tests/apiRouter.test.js（路由表行为 11 项）与 tests/mutationRecording.test.js（服务层记录 7 项）；存量测试零改动。
- ADR 0004 记录决策。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`）。

### Modified Capabilities

无（路由顺序语义、404 门禁差异、错误契约、公开/半公开端点面均与迁移前一致）。
