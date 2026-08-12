## Context

StarNav 已有浏览器插件（`extensions/browser-bookmark/`，MV3）：popup 当前是单页收藏表单 + 底部一键同步区（`popup.html` 无 tab 结构，`popup.js` 已有 `apiFetch`/`normalizeBaseUrl`/`config` 模式）。站内读接口齐全：`GET /api/config`（catalog/keyword/tag/page/pageSize/sort/space 参数，公开读 + 私人过滤）、`GET /api/search?q=`、`GET /api/categories`（公开）。

现有鉴权事实（api.js）：
- `/config` GET、`/search`、`/ai/chat` 的 `privateAccess = adminAuthed || hasPrivateBookmarkAccess(request, env)`——**不认 Bearer Token**；`isPrivateBookmarkCategory(catalog) && !privateAccess → 401`。
- 整站锁门禁（`src/handlers/siteLock.js` + `validateApiToken`）已放行有效 Bearer，锁站下 token 客户端可读公开数据。
- `validateApiToken(request, env, '')` 接受任何有效（未吊销/未过期）token。

约束：
- popup 尺寸有限（~380×560），交互要适配小空间；popup 生命周期短（失焦即关），不可做长驻状态。
- 站点 `logo` 字段已有（自动抓取），缺失时不能发外部 favicon 请求（隐私 + 插件 host 权限已全开但没必要）。
- 不动 `/go` 跳转与计数逻辑（点击直开原始 URL，不计数）。

## Goals / Non-Goals

**Goals:**
- 弹窗内浏览站内书签：搜索、分类筛选、排序、分页、点击打开。
- 私人书签对有效 token 客户端可见（插件能看全站）。
- 浏览为默认视图；收藏、同步视图保留现有能力。
- 每次打开弹窗拉取首页与分类（2 个 GET），切换分类/搜索/排序时增量拉取。

**Non-Goals:**
- 不经过 `/go`（不计数、不记录最近访问）。
- 不做多 space 切换、无限滚动、离线缓存、浏览→收藏联动。
- 不改 token 模型（无 scope 细分，ADR-0002 定语义）。

## Decisions

1. **后端：token 计入 privateAccess（3 处）**。
   `api.js` 的 `/search`、`/ai/chat`、`isSitesCollectionPath GET` 三处：`adminAuthed || tokenAuth.authenticated || hasPrivateBookmarkAccess`，其中 tokenAuth 用 `validateApiToken(request, env, '')`（复用现有模式，`forbidden` 语义不变——scope 不足仍 403）。理由：token 是密码级凭据（ADR-0002）；一处 helper 封装避免三处重复。
   备选：scope 区分/专用开关——token 模型无此维度，拒绝。

2. **插件布局：popup 改三 tab（浏览 / 收藏 / 同步），浏览为默认**。
   现有收藏表单与同步区平移为 tab 内容，`popup.js` 加 tab 切换逻辑（显示/隐藏 + 激活样式）。理由：浏览是高频动作（用户原话"不用每次打开网站"）。
   备选：浏览做二级页面——高频入口藏深，拒绝。

3. **浏览视图：搜索框 + 分类胶囊 + 列表 + 加载更多**。
   - 搜索：输入防抖 300ms，`GET /api/config?keyword=`（与分类筛选组合时单接口统一，不用 `/api/search`——后者无 catalog 参数）。
   - 分类：`GET /api/categories` 渲染横滚胶囊（含私人书签）；「全部」为默认。
   - 排序：`sort` 参数——`''`（站点序）/ `hits`（热门）/ `last_visit`（最近访问）/ `name`（名称）。
   - 分页：pageSize 30，「加载更多」按钮按响应 total 判终止（popup 内滚动监听不稳，弃无限滚动）。
   - 列表项：logo（缺失 → 首字母占位）+ 标题 + 域名；点击 `chrome.tabs.create({url, active:true})` 并 `window.close()`。
   - 状态：加载中骨架 / 空态（"未找到书签"）/ 错误（401 token 失效提示重新配置、网络/锁错误透出 message）。
   - 打开弹窗：并行拉首页列表 + 分类（2 GET），失败可手动刷新（刷新按钮重拉当前视图）。

4. **私人书签胶囊**：分类列表含私人书签；token 有效则点击可见（后端 1 已保证），token 无效/过期 → 401 错误态展示。不额外隐藏。

5. **i18n**：插件弹窗保持中文（现有单语），后台无新文案；`docs/api-guide.md` 补 token 私人可见语义。

## Risks / Trade-offs

- **token 泄露面扩大**：任何持 token 的第三方可读私人书签（ADR-0002 已接受，文档写明）。缓解：token 可吊销。
- **点击不计数**：浏览打开不产生 hits/最近访问。可接受（用户选择直开；站内跳转仍是网站内行为）。
- **popup 无长驻状态**：每次打开 2 个请求，慢网下首次渲染有等待——骨架屏缓解；分类缓存被拒（用户选择每次拉取，数据新鲜优先）。
- **`/api/config` 大列表响应**：pageSize 30 限制传输；列表项不渲染 desc 保持轻量。
