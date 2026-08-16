## Context

- 图标自动补全现状：`siteService.ensureSiteFavicon`（策略 + `favicon:failed:{id}` 永久标记 + 手动刷新清标记）、`lib/favicon.js:getFavicon`（6 源纯抓取）、go.js:28（waitUntil 触发）、api.js 两条路由（GET /favicon、POST /site/:id/ensure-favicon）、background.js:164-218（编排 + 28000 超时 + FAVICON_DEBUG_LAST）、popup.js:227-239（10 分钟调试展示）。
- popup.js 结构：els 注册表（1-41）→ collect 逻辑（140-448，含插件搜索 450-508）→ TAB_CONFIG/switchTab（510-538）→ browse 逻辑（540-993）；`initPopup()` 底部直调。browse 视图状态：browseState/browseCategories/expandedCategories/suppressAncestorInjection/browseLoadInFlight 均模块级。
- 既有 UMD 先例：extension-contract.js / popup-logic.js（`(function(global){...})(typeof self !== 'undefined' ? self : globalThis)` + module.exports 守卫），node 测试用 vm.runInThisContext 加载。
- popup-view-persist.test.js 只锁 popup.js 三个函数（applyBrowseView 内 saveBrowseView、save 三字段、restore 不写）——语义随迁至 browse-view.js。

## Goals / Non-Goals

**Goals:**
- 图标补全策略/状态/编排各自有主（worker 一个模块、契约一个来源）；超时与失败原因无魔数。
- 视图层有运行时 seam（mount/onEnter/onLeave），DOM 冒烟可测；正则锁退役。
- 行为逐位保持：监听绑定点、tab 切换时序（收藏视图 onEnter 查重、离开清状态条）、浏览缓存刷新链。

**Non-Goals:**
- 不接入 options.js 的 CONFIG_KEYS 旁路（契约已存在，消费方接入属后续）。
- 不给 popup 壳本身写自动化测试（tab 切换仍手工验证；视图 seam 已覆盖主要行为）。
- 不合并 background 的四职责（预热/菜单/收藏/ensure-favicon 编排）——本批只消除跨 seam 魔数。

## Decisions

### D1：iconService 收策略与状态，lib/favicon.js 保持纯抓取
迁出 siteService 的 ensureSiteFavicon/faviconFailedKey/bulkRefreshSiteFavicons（含 SITE_BULK_FAVICON 记录，C6 服务层记录随迁）；go.js 与 api/resources/sites.js 改从 iconService 导入；siteService 仅保留 updateSite 的清标记调用（import faviconFailedKey）。无循环依赖（iconService 不依赖 siteService）。
- 替代：策略留 siteService——概念继续埋在大模块里，跨 seam 理解成本不变。

### D2：契约持有超时与失败原因枚举
`ICON_TIMEOUT_MS = 28000`（注释携带"5 源 × 5s ≈ 25s + 余量 < Workers 30s"预算说明）、`ICON_FAILURE_REASONS`（has-logo/already-failed/no-favicon/error/no-site/filled，与 worker reason 逐字对齐）、`ICON_DEBUG_TTL_MS = 10 * 60 * 1000`。background.js 消费超时常量与 has-logo 枚举；popup.js 消费 TTL。契约测试断言超时预算区间（>25s 且 <30s）与原因枚举。
- 替代：客户端从响应推导超时——过度设计；服务端预算进响应头——增加协议面。

### D3：视图工厂 + ctx 注入
视图模块 `create(ctx)` 返回 `{ mount, onEnter, onLeave }`；ctx 由壳构造：`{ els, Contract, BrowseLogic, config: () => config, setStatus, apiFetch, escapeHTML, getActiveTab, onCacheMutated, document, localStorage }`。壳保留元素注册表与 tab 状态机；`switchTab` 调 `collectView.onEnter()/onLeave()`。browse 视图暴露 `refreshAfterCacheMutation` 供壳接 `onCacheMutated`（惰性箭头，避免装配顺序问题）。
- 测试 seam：ctx 全注入（含 document/localStorage），stub 无需实现全局 DOM；行为面 `_handlers`（getPayload/saveBookmark/autoCheckDuplicate/flattenBookmarks…）供测试直调。

### D4：mount 一次性、逐字迁移
监听绑定集中在 mount()；重复调用会重复绑定（文档注明"启动时调用一次"）。代码逐字迁移（含注释），不做行为微调；browse 的 restore/load 初始化从 initPopup 移入 mount。

## Risks / Trade-offs

- **拆分遗漏**：跨视图共享（saveBookmark/syncBookmarks → refreshBrowseCacheAfterMutation）以钩子收敛——漏接会退化为缓存不刷新，由 saveBookmark 冒烟断言 onCacheMutated 调用守护。
- **契约枚举漂移**：worker 侧 reason 字符串与契约枚举靠测试对齐（extension-contract.test.js 断言逐字值）。
- **正则锁退役**：applyBrowseView 统一保存/restore 不写回两个不变式随代码迁移保留，失去源码锁——以浏览视图冒烟（mount 后全量拉取初始化路径）部分覆盖。
