## 1. 服务端全量接口

- [x] 1.1 `siteService.getSites` 新增 `all` 参数：`all=1` 时取消 LIMIT/OFFSET，返回全部可见书签（默认排序创建时间倒序），fallback 分支同步；`total` 返回全量条数
- [x] 1.2 `api.js` `/api/config` 与 `/api/sites` 透传 `all` 查询参数
- [x] 1.3 测试：`siteService` 全量模式（可见性过滤、total、排序）；node:sqlite 真库验证（复用 repro-catalog-tree 模式）

## 2. 插件纯逻辑层（popup-logic.js）

- [x] 2.1 缓存决策 `decideBrowseView` 重写为全量语义：新格式（kind==='full'）新鲜 → render+零请求；过期 → render+后台刷新；**旧格式/未知格式（无 kind==='full'）→ 视为无缓存（render:false，初始化态拉全量重建）**；无缓存 → render:false（初始化态）
- [x] 2.2 新增 `filterBrowseItems(items, view)`：keyword 子串（大小写不敏感）、catelog 含子孙、sort（default/hits/last_visit/name）——纯函数；**守卫：仅对 kind==='full' 缓存生效，非 full 不得对部分数据过滤**
- [x] 2.3 新增 `paginateItems(items, page, pageSize)` 客户端分页切片
- [x] 2.4 新增 `isFullBrowseCache(cache)`：识别新格式（kind==='full'）；非 full（旧格式/未知）按无缓存处理丢弃

## 3. 插件 DOM 层（popup.js / popup.html）

- [x] 3.1 拉取路径：打开/过期/收藏/同步 → `Promise.all([/api/config?all=1, /api/categories/tree])` 写新格式缓存；旧格式缓存识别后丢弃（走 2.4）
- [x] 3.2 `loadBrowseView` 按新决策渲染：零请求分支、初始化态分支、过期后台刷新
- [x] 3.3 浏览搜索/分类点击/排序/加载更多改为客户端过滤渲染（去掉对应 fetch）；**守卫：缓存非 full（旧格式/拉取中）时任何视图切换动作先等待或触发全量拉取，不得对部分数据过滤**
- [x] 3.4 初始化态 UI：骨架 + 「正在初始化书签…」文案 + 失败重试（首开/守卫/手动刷新失败渲染 `.browse-retry`，browseList 事件委托点击重试；静默后台刷新失败不打断当前列表）
- [x] 3.5 `refreshBrowseCacheAfterMutation` 保持"等待在途任务"语义，目标改为全量重拉
- [x] 3.6 `background.js` 预热（onInstalled/onStartup）同步新格式：拉 `/api/config?all=1` + 分类树，写 `{ kind:'full', fetchedAt, ttlMinutes, items, total, categories }`（ttlMinutes 读 sync.browseCacheMinutes）；不得再写旧格式覆盖新缓存

## 4. 测试与验证

- [x] 4.1 `tests/popup-logic.test.js`：更新决策矩阵用例（新语义）、新增过滤/分页用例、**旧格式 fixture 用例（无 kind==='full' → decideBrowseView 返回 render:false，走初始化态重建）**
- [x] 4.2 全量测试 + 语法检查通过；扩展手动重载验证：有缓存零请求（Network 面板无 /api/config）、切视图秒开、收藏后缓存更新
