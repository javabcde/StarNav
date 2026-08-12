## Why

浏览器收藏夹是用户书签的事实源：日常收藏发生在浏览器侧，StarNav 的站点列表需要与之一致。目前两者靠手动维护——扩展单条收藏、后台手工添加，浏览器里新增/改名/删除的书签不会反映到 StarNav，反之 StarNav 的手动书签也不该被浏览器状态抹掉。用户要一个「一键同步」：以浏览器收藏为事实源完全对齐，但**不覆盖手动加的**。

## What Changes

- 新增 `bookmark-sync` 能力：以浏览器收藏全量快照为事实源，把 StarNav 中**同步来源书签**（`sync_source='browser'`）完全对齐——新增、改标题/URL/分类、删除；**手动书签**（`sync_source='manual'`）永不参与（不更新、不删除，且其 URL 去重键挡住同名浏览器书签的插入）。
- 双入口共用后端对齐管线：扩展 popup「一键同步」按钮（`chrome.bookmarks.getTree()` 全量快照，需给 manifest 加 `bookmarks` 权限）；后台数据管理页上传浏览器导出的 `bookmarks.html`（浏览器端 DOMParser 解析为同一结构化快照）。文件路径同样全量对齐含删除，上传前确认框展示「将删除 N 项」（防选区导出误删）。
- 配对：`url_key`（规范化 URL）为主匹配键，扩展路径以浏览器书签 ID 辅助（URL 被改时原地更新 `url_key`）；HTML 路径无 ID 则 URL 被改 = 删旧插新；多浏览器按 URL 合并、后同步者覆盖。
- 对齐字段范围仅 name、url、分类；visibility、排序、访问次数、描述、logo 等 StarNav 本地属性不动。
- 分类映射：文件夹拍平为「父/子」只新建（不传播改名/删除）；root 根（书签栏/其他书签/移动设备书签）不建分类，顶层项归「未分类」；范围含移动设备书签。
- 删除安全：同步删除前写 `operation_logs`（含被删 URL/标题/时间），可追溯不恢复。
- **空快照保护**：浏览器快照不含任何书签（URL 条目为 0）时同步拒绝执行，服务端硬拦截（400），不产生任何增/改/删——防浏览器同步故障/空导出导致全量误删。
- 「解除同步」：后台编辑入口把同步书签转为手动书签（`sync_source` 置 manual 并清除浏览器 ID），此后不参与对齐。
- Schema 迁移：`sites` 加 `sync_source TEXT NOT NULL DEFAULT 'manual'`、`browser_bookmark_id TEXT`，加索引；存量行默认 manual 无需回填。

## Capabilities

### New Capabilities

- `bookmark-sync`: 浏览器书签对齐同步——来源标记、全量对齐引擎、双入口、手动书签保护、分类映射与删除安全。
