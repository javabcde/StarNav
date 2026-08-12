## Context

StarNav 是 Cloudflare Workers + D1 + KV 的书签导航系统。站点（`sites` 表）有 name/url/catelog/category_id/visibility/sort_order/hits/url_key 等字段，`url_key` 是 URL 规范化后的去重键（`normalizeDuplicateUrlKey`：去 `www`/尾斜杠/大小写，保留 query，http/https 同键）。已有 `importSites(env, jsonData, {mode:'merge'|'overwrite'})` 增量导入管线（JSON 载荷、url_key 去重、分类自动创建），语义为一次性导入——与本次「完全对齐」不同，需新管线而非复用。

现有可复用件：
- `src/services/siteService.js`：`normalizeDuplicateUrlKey`、`upsertCategoryByName`、`getExistingUrlKeySet`、`setSiteTags`、`normalizeSitePayload`、`clearBookmarkData`。
- `src/lib/auth.js`：Bearer Token 校验 `validateApiToken`（site lock 门禁同样使用）、管理员会话 `isAdminAuthenticated`。
- `src/services/siteLockService.js`：整站锁门禁——同步 API 需过 API 凭据判定（锁 Cookie 或有效 Bearer Token 或管理员会话）。
- `src/services/backupService.js` 的 `restoreBackup` 调用 `importSites`（manual 语义，不受影响）。
- `extensions/browser-bookmark/`：MV3 扩展（权限 activeTab/storage/contextMenus/notifications，**无 bookmarks**），popup 已有 `apiFetch`（Bearer token）与站点保存流程。
- `operation_logs` 表：action/target/summary/detail/ip/create_time，已有写入模式。
- `sitesToBookmarkHtml`（导出 Netscape 格式）——导入是其逆方向。

约束：
- `sites.url_key` 无 UNIQUE 约束（普通索引）——去重靠应用层集合。
- Workers 请求体/D1 batch 限制：大批量写需分批（~100 条/批）。
- 扩展端需新增 `bookmarks` 权限；开发者模式自装无审核。
- 同步 API 在 site lock 启用后必须能通过门禁（Bearer token 或管理员会话）。

## Goals / Non-Goals

**Goals:**
- 一键以浏览器收藏为事实源，把同步来源书签完全对齐（增/改/删）；手动书签永不被动。
- 双入口（扩展一键 + HTML 文件上传）语义一致：文件路径全量对齐含删除，删除前确认。
- 对齐仅限 name/url/分类；本地属性（visibility/排序/hits/desc/logo）不动。
- 删除可追溯（operation_logs）；「解除同步」可把同步书签转手动。
- 大书签库（万级）单次同步在 Workers 时限内完成。

**Non-Goals:**
- 不做双向同步（StarNav 改动不回写浏览器）。
- 不做本地优先（浏览器赢；手动编辑同步项会被覆盖，需「解除同步」承接保留诉求）。
- 不做软删/回收站。
- 不传播分类改名/删除（只新建缺失分类）。
- 不改动现有 `importSites`（JSON/CSV/备份恢复保持 manual 语义）。

## Decisions

1. **来源标记：`sites.sync_source TEXT NOT NULL DEFAULT 'manual'` + `sites.browser_bookmark_id TEXT`。**
   存量行自动 manual，零回填。扩展单条收藏、现有导入、备份恢复均写 manual；仅同步管线写 browser。加索引 `idx_sites_sync_source (sync_source, browser_bookmark_id)`。
   备选：单独同步表存映射（查询多一跳、一致性难保证）——拒绝。

2. **对齐引擎：新 `src/services/bookmarkSyncService.js`，全量快照 diff。**
   输入 `{items:[{id?, title, url, folderPath}], source:'extension'|'html'}`。加载全部 `sync_source='browser'` 站点构建 `Map<url_key, site>` + `Map<browser_bookmark_id, site>`，遍历浏览器快照：
   - ID 命中 → 原地更新（URL 变则重算 url_key）
   - 否则 url_key 命中 sync 项 → 更新 name/catelog
   - 否则 url_key 命中 manual 项 → 跳过（手动优先）
   - 否则 → 插入（`sync_source='browser'`，记浏览器 ID）
   快照结束后，未被命中的 sync 项 → 删除（先写 operation_logs）。
   理由：O(N+M) Map 查找，一次请求完成；不依赖浏览器侧快照历史。
   备选：复用 `importSites` merge + 单独删除扫描——语义不符（merge 不更新已存在项、且不识别来源）。

3. **配对键：`url_key` 主键 + `browser_bookmark_id` 辅助。**
   扩展路径 ID 稳定（Chrome/Edge 同源书签），URL 被改时靠 ID 认出同一书签原地更新（保留 hits/排序）；HTML 路径无 ID，URL 被改 = 删旧插新（hits 丢失，可接受）。多浏览器（Chrome+Edge 同时同步）按 URL 合并，后同步的浏览器覆盖同 URL 项（last-write-wins）。
   备选：纯 URL 匹配（URL 编辑频繁时反复删插、hits 清零）、纯 ID 匹配（HTML 路径/跨浏览器不可用）——均拒绝。

4. **字段范围：仅 name、url、catelog 对齐。**
   visibility/sort_order/hits/desc/logo 是 StarNav 本地属性，同步不写。理由：浏览器书签无这些概念，对齐会重置用户本地调优。
   注意：插入新项时走 `normalizeSitePayload` 默认值（公开可见性、默认排序）。

5. **分类映射：文件夹拍平「父/子」→ `upsertCategoryByName` 只新建。**
   root 根（书签栏/其他书签/移动设备书签）不建分类，顶层项归「未分类」；自定义文件夹建分类；嵌套拍平为 `父/子` 字符串。分类改名/删除不传播（避免误伤手动分类）。范围含移动设备书签（用户确认）。

6. **文件路径全量对齐（含删除），上传前确认框展示「将删除 N 项」。**
   HTML 文件视为与扩展同等的全量快照。风险：选区导出导致文件外 sync 项被删——确认框展示删除数与「删除同步书签」警示；另支持「仅预览」先看差异。理由：双入口语义一致（用户确认）。

7. **删除安全：同步删除前写 `operation_logs`（action='sync_delete_bookmark'，target=url，summary=标题）。**
   可追溯不可恢复（不做回收站，用户确认）。误删恢复依赖浏览器侧。

8. **「解除同步」：后台站点编辑入口，`sync_source` 置 manual + 清 `browser_bookmark_id`。**
   解除后该 URL 再次出现在浏览器快照时被 manual 项挡住（跳过）。API：`PUT /api/sites/:id/sync`（body `{unsync:true}`）或并入站点编辑。

9. **双入口与鉴权：**
   - 扩展：popup「一键同步」→ `chrome.bookmarks.getTree()` 展平（递归，含 id/title/url/folderPath）→ `POST /api/sync/bookmarks`（Bearer token，同现有 `apiFetch`）。
   - 后台：数据管理页「同步书签」分区 → 文件选择 → 浏览器端 DOMParser 解析 Netscape 格式 → 同端点（管理员会话）。
   - 端点鉴权：管理员会话或有效 Bearer Token（`validateApiToken(request, env, '')`），site lock 门禁天然兼容。

10. **性能：全量 diff Map + D1 batch 分批（~100 条/批）写增/改/删。**
    万级书签单请求内完成；解析 JSON 与 Map 构建不占瓶颈。结果报告：新增/更新/删除/跳过/失败计数 + 失败条目列表。

11. **空快照保护：`items` 长度为 0 时同步拒绝执行（400），零写入。**
    对齐模型下空快照等价于"删光所有同步书签"——浏览器同步故障、选区导出空文件、解析失败都会产生空 items。拦截落在服务端（权威），扩展/文件路径客户端仅为 UX 前置提示。理由：全量删除不可逆（仅日志），空快照是最常见的灾难输入。
    备选：空快照视为"全量清空"（尊重事实源）——拒绝，误删成本远高于不便；用户真要清空可手动删或批量解除同步。

## Risks / Trade-offs

- **删除不可逆**：浏览器误删书签 → 同步删除 StarNav 项（仅日志追溯）。缓解：文件路径确认框、扩展路径按钮二次确认文案、operation_logs 留痕。用户已接受。
- **空快照灾难**：客户端异常（浏览器同步故障、选区导出空文件、解析失败）可能产生空 items → 无保护时全量对齐会删光同步书签。缓解：服务端硬拦截（Decision 11），客户端前置提示。
- **同步项本地编辑被覆盖**：用户在 StarNav 改过同步项（改名/换分类）会被浏览器状态覆盖——设计如此（浏览器赢），「解除同步」是保留手段。文档需写明。
- **选区导出误删**：HTML 文件不全时文件外 sync 项被删。缓解：确认框展示删除数 + 支持先预览。
- **多浏览器冲突**：同一 URL 在两浏览器标题不同 → 后同步者赢。可接受（用户确认）。
- **URL 规范化边角**：保留 query 的键会把带 session/utm 参数的收藏算作不同书签；http/https 同键（与现有导入一致）。可接受，与全站去重语义统一。
- **扩展权限升级**：manifest 加 `bookmarks` 权限，Chrome 商店审核（若上架）会审查；个人开发者模式加载无影响。
