## Context

- popup.js 浏览区（568-1052 行）：`browseState` 10 字段（popup.js:572-585）穿过 loadBrowseView / loadFullCache / useFullCache / applyBrowseView / ensureBrowseCache / renderBrowseList / observeBrowseMore / renderCategories / saveBrowseView / restoreBrowseView；6 个模块级单例（`browseCategories`、`expandedCategories`、`suppressAncestorInjection`、`browseLoadInFlight`、`browseMoreObserver`、`browseSearchTimer`）。
- popup-logic.js 已有手风琴语义的一半：`toggleCategory`（同一时间只展开一个父分类）、`injectAncestors`（筛选子分类时祖先链自动展开）、`ancestorsOf`、`collectCategoryGroups`——全部纯函数、node 直测。
- 分裂的另一半：renderCategories 切换事件里内联的「收起父分类时若其子孙正被筛选，筛选改指父分类」（collapsedChangedFilter 语义），DOM 闭包中，无测试。
- 持久化：`BROWSE_VIEW_KEY = 'browse:view:v1'`（popup.js:892，键名归 extension-shared-contract 契约模块）+ `saveBrowseView` / `restoreBrowseView`（893-915）直接读写 localStorage；测试退化为源码正则断言（popup-view-persist.test.js:15-37，注释自述「无运行 seam 可测」）。
- 客户端过滤/分页纯函数已在 popup-logic.js（filterBrowseItems / paginateItems / browseHasMore / decideBrowseView / isBrowseCacheFresh）。

## Goals / Non-Goals

**Goals:**
- 视图状态（筛选/搜索/排序/页码/展开集/抑制标志 + 序列化）成为可测状态机：显式状态对象 + 纯 transition。
- popup.js 浏览区瘦身为渲染 + 事件接线；副作用句柄（在途 promise、observer、定时器）留在 DOM 层。

**Non-Goals:**
- 不改变任何用户可见行为（手风琴、祖先注入、收起重定向、无限滚动、视图恢复逐条保持）。
- 不把副作用调度（在途拉取去重、observer 生命周期）收进状态模块。
- 不新建文件：状态机扩展进 popup-logic.js（它就是浏览逻辑的 owner）。

## Decisions

### D1：纯函数 + 显式状态对象
`viewState = { catalog, search, sort, page, expanded: Set, suppressAncestorInjection, restored }` 作为普通对象由 popup.js 持有；transition 纯函数 `applyBrowseFilter(state, next)` / `applyBrowsePage(state, page)` / `toggleCategoryInState(state, name)` / `collapseChangedFilter(state)` / `restoreViewState(state, saved)` 返回新对象。与 BrowseLogic 全纯函数风格一致，测试直接构造状态对象断言转移。
- 替代：类 store——状态封装更严但引入类风格，与仓库函数式风格不一致；最小侵入只搬函数——6 个单例仍散。

### D2：持久化拆分为纯反序列化 + 薄壳 IO（旧正则锁不动，实现期修正）
`deserializeView(raw)`（非法输入回退 null、字段 String 强转）进状态模块（纯）；popup.js 保留 `saveBrowseView` 原样（序列化形状 catelog/keyword/sort + ts 受 popup-view-persist.test.js 正则锁约束，必须留在函数体内——故 `serializeView` 不入模块，避免死代码）与 `restoreBrowseView` 薄壳（`BrowseLogic.deserializeView` + localStorage 读，无 setItem）。`popup-view-persist.test.js` 一字不动（用户约束：旧测试不改、新老全绿）；序列化行为由新增测试覆盖。
- 替代：整个持久化（含 storage 读写）进模块——模块不再纯，需 mock chrome；删除旧正则锁改行为测试——违反「旧测试不动」约束；serializeView 入模块——正则锁要求三字段字面量在 popup.js 函数体内，模块版即死代码。

### D3：边界——逻辑状态全收，副作用句柄留 DOM 层
收编：catalog/search/sort/page/expanded/suppressAncestorInjection + 序列化。留 DOM 层：`browseLoadInFlight`（在途 promise，与渲染无关的并发去重）、`browseMoreObserver`（IntersectionObserver 实例）、`browseSearchTimer`（防抖定时器）、`lastDuplicate` / `lastCheckedDuplicateUrl`（收藏 tab 查重去重）。
- 替代：连副作用句柄一起收——模块承担 IO/调度，纯逻辑面破坏。

### D4：与契约模块的边界
`BROWSE_VIEW_KEY` 键名常量属 extension-shared-contract（存储键契约）；视图状态的语义与形状属 popup-logic（浏览逻辑）。两变更独立落地，本变更只消费契约导出的键名常量。

## Risks / Trade-offs

- **行为回归**：手风琴/祖先注入/收起重定向三规则从「DOM 闭包 + popup-logic 各半」合并到一处纯函数——三规则交互（收起→重定向→注入抑制）需行为测试逐条锁定，冒烟时打开/筛选/收起/切视图走一遍。
- **渲染重入**：transition 返回值驱动渲染，需保证 popup.js 每次变更以新状态渲染（无内部再变异）——以 popup-logic 现有过滤/分页函数的纯性为基准。
- **测试约束**：旧正则锁一字不动——薄壳必须保持三个断言形态（applyBrowseView 调 saveBrowseView / save 含三字段 / restore 无 setItem），改造 wrapper 时以旧测试为守护；新增行为测试不替代它。
