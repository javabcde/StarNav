# 路由表收编为表驱动 dispatcher，变更记录与可见性 SQL 归服务层

api.js 的 848 行精确路径 if 链（~45 端点、~35 处内联 `requireAdmin`、15+ 处手写审计摘要、3 份逐字复制的三段鉴权）与 siteService 内 6 份逐字复制的可见性 SQL 谓词，把"加一个端点/改一条规则"的成本摊到每个分支上。ADR-0003 已把访问规则收编进 accessService，但 SQL 渲染与路由表本身被留在原地。

Status: accepted

## 决策要点

- **表驱动 dispatcher**：`handlers/api.js` 收缩为 `ROUTES` 表（`[match, handler]`，先匹配先得），handler 按资源拆进 `handlers/api/resources/{sites,categories,tags,backups,settings,analytics,admin,ai}.js`，签名统一 `(request, env, ctx, path, method, id, url)`，未命中返回 null 落到 404。静态段条目必须排在参数段条目之前。
- **鉴权随资源模块走**：每个端点自己的 `requireAdmin` 留在资源模块内；`/site/preview` 与 `/submit/suggest-*` 的三段鉴权（管理员 cookie / write token / 投稿开关）收编为 `errors.js` 的 `requireSubmitter`。
- **变更记录归服务层**：`createSite/updateSite/deleteSite/bulk*/reorder/import/approve/reject/unsync`、分类、标签、备份、同步的汇总记录全部移入写服务内部（`bookmarkSyncService` 本就如此），handler 不再手写 `safeLog(logOperation(...))`。定时任务等非 HTTP 写路径自动获得记录。
- **IP 可选上下文**：`logOperation` 新增 `ip` 字段（`request` 兼容保留）；资源模块每请求提取一次 `clientIpFromRequest(request)` 经服务 options 传入。服务层不持有 Request 对象（约定不变）。
- **可见性 SQL 单一渲染**：`accessService.visibilityWhere(access)` 返回 `{ sql, binds }`，siteService 六处列表/搜索查询（getSites/getAllSites/searchSites/listSitesByIds/搜索回退）经本地 `applyVisibilityWhere` push 消费；`filters.visibility` 站点筛选与无 join 遗留回退的 `s.catelog <> ?` 不属于访问规则，不动。补完 ADR-0003 未收的渲染面。

## Consequences

- 新增端点 = 路由表加一行 + 资源模块加一个函数；改访问规则 = 只动 accessService 一处。
- 行为保持：路由顺序语义（静态优先）、未知方法落 404 的门禁差异（tokens/:id 非 DELETE 不进门禁、/categories 集合未知方法不进门禁）、错误契约、公开/半公开端点面均与迁移前一致。
- 审计记录从 waitUntil 非阻塞变为服务内 await 阻塞：管理员写路径每次变更多一次 D1 写（毫秒级），webhook 投递随之阻塞响应——变更频率低、投递超时有界，接受；若未来需要可给服务穿 ctx 恢复 waitUntil。
- 变更记录摘要由服务从规范化数据生成（如 `bulkUpdateSites` 的字段清单），不再依赖 handler 手写，杜绝新端点漏记与摘要漂移。
- `getSiteRouteFlags`（api/sites.js）随路由表消亡；序列化函数（sitesToCsv/sitesToBookmarkHtml）保留。
- 未覆盖：`/spaces`（沿用既有 handleSpacesApiRequest 约定）、settings 更新与 token/webhook 写操作维持迁移前"不记录"行为（无对应操作码，不新增）。
