## Context

- 站点图标存 `sites.logo`（favicon URL 字符串），空 = 无图标。现有获取路径：添加书签时手动抓取、admin「批量刷新图标」`POST /api/config/bulk`（≤30 个，仅 admin session）。
- 服务端已有 `getFavicon(url)`（`src/lib/favicon.js`）：6 源抓取返回 URL（5 聚合/标准源串行 + 源站 HTML `<link rel=icon>` 解析，各 5s 超时），SSRF 防护（拒绝内网/保留域名，私有 IP 站点自动补全永不生效、需手动填 logo）。`extractHtmlFavicon` 纯函数与 fetchSitePreview 共用。
- 主站所有书签链接统一走 `/go/:id`：`canAccessSite` 权限检查（无权 404，连触发都不行）→ `incrementSiteHits` 放 `waitUntil` 后台 → 跳转 HTML。`site` 对象（logo/url/id）已在 handler 手上。
- 插件站内浏览点击直接 `chrome.tabs.create` 外部 URL，**不经服务端**；插件有 Bearer token（storage.sync），但 `requireAdmin` 默认不带 `allowApiToken`，token 调不了 bulk 接口。
- 插件 full cache（`browse:cache:v1`）存 `chrome.storage.local`，popup 与 background **共享同一存储**（可本地 patch 单条）。
- 主站首页为 SSR + 边缘缓存（`caches.default`，键含 catalog/sort/tag/lang 多维组合，s-maxage=60 自动过期）。
- 同步对齐只动 name/url/catelog，不动 logo——补完能留。

## Goals / Non-Goals

**Goals:**
- 主站 `/go/:id` 点击无图标书签 → 后台异步补图标（不阻塞跳转）。
- 插件站内浏览点击无图标书签 → 经 background 上报补图标，成功后本地 patch 缓存该条，下次打开 popup 即见新图标。
- 抓取失败的站点永久放弃自动重试（KV 标记），仅手动操作（admin 批量刷新、编辑书签）重置。
- 接口与写回路径均带鉴权，不引入新的公开写入口。

**Non-Goals:**
- 不 purge 主站边缘缓存（靠 s-maxage=60 自动过期）。
- 不做定时全量扫描补图标（仅点击触发）。
- 不覆盖已有图标（只补 `logo` 空的）。
- 不改变 `getFavicon` 的源抓取策略（6 源：5 聚合/标准源 + 源站 HTML 解析，实现期新增 HTML 源为诊断驱动，见第 5 组任务）。

## Decisions

### D1：幂等服务 `ensureSiteFavicon(env, site)` 统一入口
三分支短路：`site.logo` 非空 → 跳过（`has-logo`）；KV `favicon:failed:{id}` 存在 → 跳过（`already-failed`）；否则 `getFavicon(site.url)`——非空写回 `UPDATE sites.logo`（`updated`），空则 KV put 永久标记（`no-favicon`）。
- 替代：直接在 `/go` 里内联 if+getFavicon——但插件接口要复用同一逻辑，抽函数避免双份实现漂移。

### D2：`/go/:id` 复用现有 waitUntil 模式
`if (!site.logo)` 追加 `ctx.waitUntil(ensureSiteFavicon(env, site).catch(log))`，与 `incrementSiteHits` 并列，不阻塞响应。
- 安全：`/go` 已受 `canAccessSite` 保护，无权者 404 连触发都不行；写回只发生在其点击可见的书签上。

### D3：新接口 `POST /api/site/:id/ensure-favicon`，token 可调
`requireAdmin(request, env, { allowApiToken: true, scope: 'write' })`——插件 Bearer token 可调，普通访客不可。`id` 校验为正整数，`getSite` 后调 `ensureSiteFavicon`，返回 `{ updated, favicon, reason }`（插件拿 favicon 做本地 patch）。
- 替代：复用 `/api/config/bulk`——token 无权限（requireAdmin 未开 allowApiToken），且 bulk 是 admin 界面批量语义，不合适。
- 替代：插件点击改走 `/go/:id`——违背"不经 /go、不计数"既有语义，且多一次跳转。

### D4：失败永久放弃 + 手动重置
KV `favicon:failed:{id}` 无 TTL。`bulkRefreshSiteFavicons` 处理每站（成功或失败）后删标记；`updateSite` 编辑时删标记（手动操作 = 重置）。
- 替代 24h TTL：用户明确"抓不到就不抓了 不用重试"——永久放弃，避免死链站反复烧外部 API。

### D5：插件 background 中转 + 本地 patch
popup 浏览点击：该条缓存 logo 空时 `chrome.runtime.sendMessage({type:'ensure-favicon', siteId})`（fire-and-forget，popup 关闭后 background 接管）。background `onMessage`：查缓存该条 logo 已非空 → 直接返回（省请求）；否则带 token 调 D3 接口（28s 超时——接近服务端 6 源最坏 30s；多数场景前几个源即命中远快于此，慢站第 6 源极端情况可能被客户端截断，此时服务端无标记、下次点击再试，无害；异常区分 timeout/network 记入调试记录）→ 拿到 favicon URL（updated 或 has-logo 均算）时 patch `items[i].logo` 写回 chrome.storage.local。
- 替代：background 补完重拉全量缓存——多一次 `/api/config?all=1`；用户选本地局部更新（零额外请求）。

### D6：主站缓存不 purge
补完图标后边缘缓存（当前视图及其他视图组合）靠 s-maxage=60 自动过期。用户明确选择，避免多维缓存键重建的复杂度。

## Risks / Trade-offs

- **外部抓取成本**：每次无图标书签点击最多 1 次 `getFavicon`（6 源串行）；成功一次后 logo 非空不再触发，失败被永久标记——成本收敛。
- **waitUntil 预算**：`getFavicon` 最坏 6 个外部 fetch 串行（各 5s 上限，共 ~30s）恰在 CF waitUntil 预算边缘——被截断只是本次没补上，下次点击重试（无标记时），无害。
- **插件 token 泄漏面**：新接口 token+scope=write 可调；接口只写 logo 且幂等，滥用面小（最多把某站 logo 改成任意 URL——注入 SVG 风险需留意，但 logo 渲染路径已有 sanitize 先例？`sanitizeCategorySvgIcon` 针对分类图标；站点卡片 logo 为 `<img>` 渲染，URL 来自外部 favicon 源同理——维持现有信任模型，不新增）。
- **并发竞态**：同站并发点击重复抓取 → 幂等 UPDATE，无害。
- **插件缓存陈旧**：补完 patch 后缓存该项即新；其他视图的搜索/排序客户端过滤基于同一 items 数组，logo 字段即时生效。
