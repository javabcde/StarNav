## 1. Schema 迁移

- [x] 1.1 `schema.sql`：`sites` 加 `sync_source TEXT NOT NULL DEFAULT 'manual'`、`browser_bookmark_id TEXT`；加索引 `idx_sites_sync_source (sync_source, browser_bookmark_id)`
- [x] 1.2 迁移说明：存量部署执行 ALTER TABLE 两条 + CREATE INDEX（README/docs 注明），存量行默认 manual 零回填

## 2. 同步服务层

- [x] 2.1 新建 `src/services/bookmarkSyncService.js`：`normalizeSyncSnapshot(payload)`（items 校验：title/url/folderPath，url 非法条目录入失败清单）
- [x] 2.2 `syncBookmarks(env, items, {source})` 对齐引擎：加载 browser 站点构建 `Map<url_key>` 与 `Map<browser_bookmark_id>`；ID 命中原地更新（URL 变重算 url_key）/ URL 命中 sync 项更新 name·catelog / URL 撞 manual 项跳过 / 其余插入；快照外 browser 项删除（先写 operation_logs，action `sync_delete_bookmark`）
- [x] 2.3 分类映射：文件夹拍平「父/子」→ `upsertCategoryByName` 只新建；root 根不建分类、顶层归「未分类」
- [x] 2.4 写入分批：D1 `batch` ~100 条/批；返回 {added, updated, deleted, skipped, failed:[{url, reason}]}
- [x] 2.5 复用 `normalizeDuplicateUrlKey`/`normalizeSitePayload`/`setSiteTags`（siteService）
- [x] 2.6 空快照保护：`items` 长度为 0 → 400「未发现可同步的书签」，零写入（服务端权威拦截）

## 3. API 路由

- [x] 3.1 `src/handlers/api.js`：`POST /api/sync/bookmarks`（body `{items, source}`）；鉴权管理员会话或 `validateApiToken(request, env, '')`；整站锁门禁天然兼容（Bearer/锁 Cookie/管理员任一）
- [x] 3.2 响应：`{ok, stats:{added,updated,deleted,skipped,failed}, failedItems:[...]}`

## 4. 扩展

- [x] 4.1 `manifest.json`：permissions 加 `bookmarks`；popup.html 加「一键同步」按钮与结果区
- [x] 4.2 popup.js：`chrome.bookmarks.getTree()` 展平（含 id/title/url/folderPath，跳过 folder 节点，root 根不建分类标记）→ `POST /api/sync/bookmarks`（复用 `apiFetch`）；按钮防重复点击（进行中禁用）；结果展示计数 + 失败明细
- [x] 4.3 空快照前置提示：展平结果无书签时禁用「一键同步」按钮并提示「未发现可同步的书签」（服务端仍权威拦截）

## 5. 后台 UI

- [x] 5.1 数据管理页「同步书签」分区：文件选择（bookmarks.html）→ 浏览器端 DOMParser 解析 Netscape 格式 → 预览（差异清单：将新增/更新/删除 N 项）→ 确认框（含「将删除 N 项」警示）→ 提交 → 结果报告展示
- [x] 5.2 解析结果为空（0 条书签）时禁用提交并提示「未发现可同步的书签」
- [x] 5.2 「解除同步」：站点编辑入口（同步书签显示来源徽标 + 「解除同步」按钮）→ API 置 manual + 清 `browser_bookmark_id`
- [x] 5.3 后台 JS/i18n 绑定（对齐 `scripts/index.js` 模式，中英文案）

## 6. 验证与文档

- [x] 6.1 新增 `tests/bookmarkSync.test.js`：来源标记默认值、全量对齐增/改/删、手动书签不动、URL 撞手动项跳过、ID 辅助 URL 原地更新、字段范围（本地属性保留）、分类拍平、删除留痕、失败条目不阻塞（对齐现有 node:test 风格）
- [x] 6.2 运行 `npm test` 与 `scripts/check-syntax.js` 全绿
- [x] 6.3 README 核心特性与 docs 更新：一键同步能力、双入口、手动书签保护语义、解除同步、文件全量对齐警示
