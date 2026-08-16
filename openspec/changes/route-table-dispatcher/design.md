## Context

- ADR-0003 已把读侧访问规则收进 accessService，但 SQL 渲染留在 siteService 六处（451/583/707/851/924/1019，迁移前编号）；ADR-0003 明示 `/submit/suggest-*` 鉴权留待"路由表重构领地"。
- api.js 现状：`handleApiRequest` 848 行 if 链；`requireAdmin` 出现 ~35 次；写分支手写 `safeLog(ctx, logOperation(...))` 15+ 处；`operationLogService.logOperation` 已联合 `dispatchWebhooks`（webhook 与审计本就在一处，问题是调用点）。
- 已有种子：`api/sites.js`（路由旗标 + 序列化）、`api/spaces.js`（`handleSpacesApiRequest`，返回 null 未命中即放行）、`api/discovery.js`（纯文档生成）——dispatcher 复用"返回 null 落 404"约定。
- `visibilityWhere` 的 6 处调用点外围都有 `!adminAuthed` 守卫，内部仅 privateUnlocked 分支差异——单一接口可完全覆盖。

## Goals / Non-Goals

**Goals:**
- api.js 变薄（848 → ~140 行），端点清单即路由表；鉴权/审计/错误映射随资源模块走。
- 可见性谓词与 binds 单一来源；变更记录所有写路径（含 cron）自动获得。
- 行为逐位保持：路由顺序、404 vs 401 门禁差异、错误契约、响应形态。

**Non-Goals:**
- 不改 `/spaces`（沿用既有 handleSpacesApiRequest 约定）。
- 不给 settings/token/webhook 写操作新增审计（无对应操作码，维持迁移前"不记录"）。
- 不做 webhook 投递的 waitUntil 恢复（记录在服务内 await，见 D3 权衡）。

## Decisions

### D1：表驱动 dispatcher，返回 null 落 404
`ROUTES = [[match, handler], ...]`，match 为 exact/prefix/regex 小工具；循环先匹配先得。参数段条目（`/sites/:id`、`/backups/:id` 等）保持原 if 链顺序排在静态条目之后；`/sites/check-duplicate`、`/backups/webdav-settings` 等具体路径先于参数路径。处理函数未命中返回 null 让 dispatcher 落到 404。
- 门禁保真：`tokens/:id` 原实现仅 DELETE 进门禁 → 新实现 `method !== 'DELETE'` 直接 null；`/categories` 集合未知方法原 404 不进门禁 → item 内 `path === '/categories'` 先行 null；`/webhooks/:id` 与 `/backups/:id` 原任意方法先进门禁 → 保持 gate-first。
- 替代：if 链薄委托——每端点仍散在路由层，接口没有变深。

### D2：`visibilityWhere(access)` 归 accessService
返回 `{ sql, binds }`：admin → 空谓词；privateUnlocked → `IN ('public','private')`；否则 `= 'public' AND COALESCE(c.name, s.catelog) <> ?`（binds 恰一个 PRIVATE_BOOKMARK_CATEGORY）。siteService 加 4 行本地 `applyVisibilityWhere` push 助手，六处替换。`filters.visibility`（912/1007）与遗留 `s.catelog <> ?`（509/617/947）不是访问规则，不动。
- 替代：独立 SQL 渲染模块——规则归属仍与 accessService 分离，ADR-0003 的"改规则只动一处"打折扣。

### D3：变更记录服务层 await，ip 可选上下文
写服务内部 `await logOperation(...)`；`logOperation` 新增 `ip` 字段（`request` 兼容保留，`clientIpFromRequest` 导出）。资源模块每请求提取一次 ip 传入服务 options。webhook 投递随之阻塞响应——管理员写路径低频、投递超时有界，接受；未来需要可给服务穿 ctx 恢复 waitUntil。
- 摘要从规范化数据生成（如 bulkUpdateSites 字段清单），不再依赖 handler 手写。

### D4：资源模块命名处理函数
每资源模块导出端点命名函数（如 `sites.create`/`sites.bulk`/`backups.item`），路由表直接引用——API 表面在表里可见，模块可被直接 import 测试。

## Risks / Trade-offs

- **行为漂移**（404/401 门禁差异、ensure-favicon 的 id 提取用中段而非末段）——apiRouter.test.js 逐项锁定，ensureFaviconApi/go/apiErrors 存量测试回归。
- **mock env 静默吞记录**：logOperation 内部 try/catch 让未配置 operation_logs 的测试 env 无感通过——新记录行为由 mutationRecording.test.js 显式断言。
- **webhook 延迟进响应路径**：await 后 admin 写操作可能等 webhook 投递（有界超时）；D3 已记录，后续可穿 ctx 改 waitUntil。
