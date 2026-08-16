## Why

1. **图标自动补全（Icon Auto-Fill）概念横跨两个 seam 六个文件**：go.js 触发、siteService 策略与 KV 永久标记、lib/favicon.js 六源抓取、api.js 两条路由、background.js 编排、popup.js 调试展示——且插件侧 28s 客户端超时靠注释与 worker 侧"5 源串行 × 每源 5s"预算手工同步（background.js:178-190），失败标记语义分叉（worker 永久放弃 vs 插件调试标记）。
2. **popup.js（994 行，40 次提交的最热文件）三视图混装**：~19 个静态监听 + 每次渲染动态重绑；刚收编的契约被旁路（CONFIG_KEYS 无消费方、buildCollectPayload 仅 background 用）；视图持久化等 DOM 逻辑只有源码正则锁（popup-view-persist.test.js）——DOM 层没有运行时 seam。

## What Changes

- **worker 侧**：新增 `src/services/iconService.js` 收编 `ensureSiteFavicon` / `faviconFailedKey` / `bulkRefreshSiteFavicons`（自 siteService 迁出，含 SITE_BULK_FAVICON 记录）；`lib/favicon.js` 保持纯抓取。
- **扩展侧契约**：`extension-contract.js` 新增 `ICON_TIMEOUT_MS`（28s，注释持有 5 源 × 5s 预算与 Workers 30s 上限）、`ICON_FAILURE_REASONS`（与服务端 ensure-favicon 的 reason 逐字对齐）、`ICON_DEBUG_TTL_MS`（10 分钟调试窗口）；background 与 popup 消费常量，魔数与字面量清除。
- **popup 三视图拆分**：popup.js 收缩为壳（元素注册表、配置加载、三 Tab 状态机、视图装配）；新增 `browse-view.js` / `collect-view.js` / `sync-view.js` UMD 视图模块，`create(ctx)` 工厂 + `mount/onEnter/onLeave` 生命周期 seam；收藏/同步的浏览缓存刷新经 `onCacheMutated` 钩子指向浏览视图。`pluginSearchInput` 属收藏视图（DOM 在 collect-view section 内），随迁。
- **测试**：删除源码正则锁（popup-view-persist.test.js），新增 stub DOM 冒烟（tests/popup-view-mount.test.js，6 项：生命周期存在、各视图监听绑定、空 URL 不查重、saveBookmark 行为面 + 缓存钩子、无缓存全量拉取初始化）；extension-contract.test.js 补图标契约断言。
- ADR 0005 记录决策。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`）。

### Modified Capabilities

无（三视图为逐字迁移：监听/状态/时序/文案不变；iconService 导出面与 siteService 原函数等价）。
