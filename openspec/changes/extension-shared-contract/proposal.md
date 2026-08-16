## Why

插件三文件（popup.js / background.js / options.js）各自实现了同一份扩展契约：`browse:cache:v1` 缓存键与全量缓存形状、TTL 默认值、flattenCategoryTree、消息类型（`ensure-favicon` / `sync-site-name`）、存储键（`favicon:debug:last`）、配置键、保存端点。拷贝已经发散出真实 bug：background.js:99-101 的右键收藏路径读 `apiUrl/apiToken`——没有任何文件写入这两个键，右键收藏必失败；background 的 flattenCategoryTree 是 popup-logic.js 已有函数的同构拷贝（注释自认）；popup 与 background 各持一条写路径（`/api/sites` vs `/api/config`）。契约靠注释纪律而非接口维持，同类 bug 会继续复发。

## What Changes

- 新建 `extensions/browser-bookmark/extension-contract.js`（UMD，与 popup-logic.js 同模式）：全量缓存键/形状/TTL 默认值、消息类型常量、存储键常量（`favicon:debug:last`、`browse:view:v1`）、配置键清单、`apiFetch(path, { baseUrl, token, timeoutMs })`、`buildCollectPayload`（形状守卫与展平函数留在 popup-logic.js——浏览逻辑 owner，旧测试孤立加载兼容）。
- popup.html 在 popup-logic.js 之前加载 contract；background.js `importScripts('extension-contract.js', 'popup-logic.js')`（classic service worker 支持）；options.html 加载 contract。
- background.js：配置键干净改名 `apiUrl/apiToken` → `baseUrl/token`；右键收藏统一走 `/api/sites` + `buildCollectPayload`（`desc`/`visibility` 作参数，409 重复警告通知保留）；两处内联 `cache.kind === 'full'` 检查改调 `BrowseLogic.isFullBrowseCache`；删除 flattenCategoryTree 拷贝。
- popup.js / options.js：apiFetch 传输实现收编为契约 `apiFetch`，两文件各留配置读取薄壳（popup 站点名校验文案、options 10s 超时语义原样保留）。
- 新增 `tests/extension-contract.test.js`（node:test，vm 加载 UMD 模式，同 popup-logic.test.js）。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`——无新需求、无既有需求变更）。

### Modified Capabilities

无（既有 spec 无行为变更：缓存形状守卫/展平逻辑迁移至契约模块属实现迁移；右键收藏从「必失败」恢复为可用是修复既有文档行为，非新需求）。
