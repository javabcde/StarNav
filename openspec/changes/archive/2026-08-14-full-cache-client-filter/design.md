## Context

插件浏览视图当前用服务端分页模型：`browse:cache:v1` 只缓存"最近一次浏览的单个视图"（签名 = 关键词|分类|排序，第一页 30 条）。切换分类/搜索/排序时签名不匹配 → 重新请求 `/api/config`（0.5~2s），再叠加免费版调度抖动，用户感知为"切换要等"。站点书签总量 500+ 条，全字段 JSON 约 100~300KB，`chrome.storage.local`（10MB 配额）无压力。浏览搜索本就是服务端 LIKE 子串匹配（非首页高级搜索），客户端可无损复刻。

## Goals / Non-Goals

**Goals:**
- 切换分类 / 搜索 / 排序 / 翻页全部秒开（客户端过滤，零网络）。
- 打开插件：有新鲜缓存 → 渲染且零请求；无缓存 → 初始化态等全量；过期 → 先显示旧数据后台拉全量。
- 收藏/同步成功后缓存自动更新（沿用等待在途任务的既有语义）。
- 缓存模型去签名，简化为"全量快照"；纯逻辑进 `popup-logic.js` 并有测试锁定。

**Non-Goals:**
- 不改造首页高级搜索（`/api/search` 的 n-gram/首字母/语法召回）——插件浏览搜索继续是子串匹配语义。
- 不做多槽缓存/LRU——全量单槽已覆盖"切换秒开"，多槽留给未来若需要。
- 不改服务端可见性/权限语义——`all=1` 复用 `getSites` 现有过滤。

## Decisions

### D1: 服务端全量模式 `all=1`

`getSites` 新增 `all` 参数：`all=1` 时忽略 page/pageSize 分页（LIMIT 取消），按当前 sort 或默认（创建时间倒序）返回全部可见书签，可见性过滤（admin/privateUnlocked/私密分类）与现有逻辑完全一致；`total` 返回全量条数。fallback 分支同步支持。默认排序保证客户端拿到稳定基线，客户端过滤时自行重排。

### D2: 缓存结构 `browse:cache:v1` 新格式

```
{
  kind: 'full',
  fetchedAt: number,
  ttlMinutes: number,        // 写入时生效的 TTL，供新鲜度判定
  items: SiteSummary[],      // 全部可见书签（全字段，服务端 all=1 返回）
  total: number,
  categories: [{name, level}],  // 分类树展平（与现格式一致）
}
```

移除 `signature`。**旧格式（含 `signature` + 单页 `items`）SHALL 被视为无效并丢弃重建**——部分数据无保留价值，不渲染、不兼容、不升级迁移。

### D3: 打开决策（简化后的 decideBrowseView）

- 新格式全量缓存（`kind === 'full'`）存在且新鲜（`fetchedAt` + 写入时快照的 `ttlMinutes`，快照防止用户中途改 TTL 造成判定漂移）→ `{ render: true, refresh: false }`（零请求）。
- 新格式缓存过期 → `{ render: true, refresh: true }`（先渲染旧数据，后台拉全量替换）。
- **旧格式 / 未知格式缓存（无 `kind === 'full'`）→ 视为无缓存：直接丢弃，走初始化态拉取全量（不渲染旧数据、无兼容路径）。**
- 无缓存 → `{ render: false }`：显示初始化态（骨架 + 文案），全量到位后渲染。
- 例外：收藏/同步成功 → 强制重拉全量（`refreshBrowseCacheAfterMutation` 保留"等待在途任务"语义）；手动刷新按钮 → 强制重拉。

### D4: 客户端过滤（popup-logic.js 新增纯函数）

- `filterBrowseItems(items, view)`：按 keyword（name/url/catelog 子串，大小写不敏感）、catelog（含子孙分类集合，复用分类树）、sort（默认站点序/hits/last_visit/name）过滤 + 排序，返回全量过滤结果。**守卫：仅对 `kind === 'full'` 的新格式缓存生效；缓存非 full 时任何视图切换动作（分类/搜索/排序/加载更多）不得对部分数据过滤，须先等待或触发全量拉取。**
- 分页渲染：`paginateItems(items, page, pageSize=30)` 切片，`total` 本地计算，"加载更多"变纯客户端追加。
- 决策矩阵 `decideBrowseView` 重写为 D3 语义；旧测试用例更新，新增过滤/分页/旧格式无效重建用例。

### D5: 初始化态 UI

无缓存首次打开：浏览列表区显示骨架条 + "正在初始化书签…"文案（复用 `.browse-skeleton` 样式族），全量到位后渲染列表并淡入。中途失败显示错误态并可重试。

### D6: 拉取方式

打开/过期/收藏触发重拉时：`Promise.all([fetch(/api/config?all=1), fetch(/api/categories/tree)])` 并行，一次写缓存（分类树随书签一起进缓存，渲染零额外请求）。

## Risks / Trade-offs

- **首次打开变慢**（无缓存时 1~2s 初始化态）：用户明确接受，且仅发生在首次/缓存被清；有缓存时保持秒开。
- **缓存体积** ~100~300KB：storage.local 配额内；`storage.onChanged` 监听和旧版插件（若同时运行）读新格式——旧插件版本读 `signature` 字段为 undefined，走"签名不匹配 → 重拉"路径，行为退化为旧逻辑但不出错（向前兼容由新格式自带）。
- **数据新鲜度**：12h TTL 内书签变更不可见（现状同样如此）；收藏/同步后立即重拉缓解。
- **客户端过滤与搜索语义**：与现服务端 LIKE 等价（子串匹配）；大小写不敏感对齐 SQLite LIKE 的 ASCII 行为。
