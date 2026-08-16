## 1. 图标自动补全模块化

- [x] 1.1 新建 `src/services/iconService.js`：ensureSiteFavicon / faviconFailedKey / bulkRefreshSiteFavicons（自 siteService 迁出，含 SITE_BULK_FAVICON 记录与手动刷新清标记）
- [x] 1.2 调用面迁移：go.js（ensureSiteFavicon）、api/resources/sites.js（ensureSiteFavicon + bulkRefreshSiteFavicons）、tests/siteService.test.js（import 改 iconService）；siteService 仅留 updateSite 清标记（import faviconFailedKey），删未用 getFavicon 导入
- [x] 1.3 `extension-contract.js` 新增 ICON_TIMEOUT_MS / ICON_FAILURE_REASONS / ICON_DEBUG_TTL_MS；background.js 28000 魔数与 has-logo 字面量改消费契约；popup.js 10 分钟 TTL 改消费契约

## 2. popup 三视图拆分

- [x] 2.1 新建 browse-view.js / collect-view.js / sync-view.js（UMD + create(ctx) 工厂 + mount/onEnter/onLeave），popup.html 按 extension-contract → popup-logic → 三视图 → popup.js 顺序引入
- [x] 2.2 popup.js 收缩为壳：els 注册表 / config / setStatus / apiFetch / TAB_CONFIG + switchTab（onEnter/onLeave 驱动）/ initPopup 装配；openSiteBtn/optionsBtn 留壳
- [x] 2.3 跨视图钩子：onCacheMutated → browseView.refreshAfterCacheMutation（saveBookmark 与 syncBookmarks 调用）
- [x] 2.4 collect 视图含插件搜索（pluginSearchInput 在 collect-view section 内）；sync 视图含 flattenBookmarks/ROOT_FOLDER_NAMES
- [x] 2.5 删除 tests/popup-view-persist.test.js（源码正则锁），新增 tests/popup-view-mount.test.js stub DOM 冒烟（6 项）

## 3. 测试与收尾

- [x] 3.1 extension-contract.test.js 补图标契约断言（超时区间 25-30s、原因枚举逐字、TTL）
- [x] 3.2 `npm run quality` 全绿（225/225，含 popup-view-mount 6 项）
- [x] 3.3 ADR 0005 记录决策（批2/3 合并记录）
- [ ] 3.4 中文提交（git）
