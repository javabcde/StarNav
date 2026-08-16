## Why

站内书签浏览视图是插件最热文件（近 80 次提交 36 次触碰 popup.js）的 bug 集中地：`browseState`（10 字段）穿过 ~10 个函数，另有 6 个模块级单例（`expandedCategories`、`suppressAncestorInjection`、`browseLoadInFlight`、`browseMoreObserver`、`browseSearchTimer` 等）。最微妙的规则——收起父分类时若其子孙正被筛选，筛选改指父分类——内联在 renderCategories 的 DOM 闭包里，与 popup-logic.js 中已封装的 `toggleCategory` / `injectAncestors`（同一手风琴语义的另一半）分裂两处。视图持久化（save/restoreBrowseView）留在 DOM 层，测试只能对源码做正则断言（popup-view-persist.test.js 注释自述「无运行 seam 可测」），改个格式就碎。

## What Changes

- popup-logic.js 新增浏览视图状态纯函数组：默认视图常量、transition（`setFilter` / `setPage` / `toggleCategory` / `collapseChangedFilter` / 视图恢复）、`serializeView` / `deserializeView`。
- popup.js：浏览视图状态收敛为单一 `viewState` 对象（popup 持有），每次变更经 transition 纯函数返回新状态再渲染；副作用句柄（在途拉取 promise、IntersectionObserver、搜索定时器、查重去重）留在 DOM 层不动。
- `popup-view-persist.test.js` 保持不动（薄壳 wrapper 维持其正则断言面）；新增状态模块行为测试；popup-logic.test.js 扩展。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`——无新需求、无既有需求变更）。

### Modified Capabilities

无（既有 spec 无行为变更：视图状态语义从 DOM 层收归状态模块属实现迁移；`browse:view:v1` 键名常量归契约模块）。
