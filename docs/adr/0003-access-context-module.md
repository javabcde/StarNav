# 访问判定集中为「访问上下文」模块

读侧访问判定（管理员会话 / Bearer Token / 整站锁 / 私人书签 / 缓存可共享性）原先散落在 `auth.js`、`siteLockService.js`、`privateBookmarkService.js`、`edgeCache.js`、`handlers/siteLock.js`、`siteService.js` 之间：三个鉴权 cookie 名在 4 个模块各自声明；edgeCache 靠「硬约束，勿删」注释维持排除名单；ADR-0002 落地时不得不改三处 `privateAccess` 计算；站点可见性规则（`canAccessSite` / `canListSite`）以布尔参数形态从 handler 散传进每个 service 调用。安全不变式依赖注释纪律而非接口。

Status: accepted

## 决策要点

- 新增 `src/services/accessService.js`：`getAccessContext(request, env)` 懒推导 + WeakMap 按请求去重，返回 `{ adminAuthed, tokenAuthenticated, tokenScopes, privateUnlocked, siteLocked, cacheAllowed }` 及 `canAccess(site)` / `canList(site)` 领域方法。
- **只收读侧判定**；写侧状态转移（登录建会话、解锁种 cookie、token 吊销、失败限速）留在原 service。
- 鉴权 cookie 名单收归 accessService（`isCacheableHomeRequest`），edgeCache 不再声明 cookie 名；整站锁白名单（`isSiteLockAllowlisted`）与路由顺序不变式随策略进模块，HTTP 呈现（302 / 403 / 锁页）留在 `handlers/siteLock.js`。
- 站点可见性规则（`normalizeVisibility` / `SITE_VISIBILITIES` / `isPrivateSite` / `canAccessSite` / `canListSite`）迁入 accessService；siteService 保留 re-export（存量测试 import 面不变）。
- `requireAdmin` 保留于 `handlers/api/errors.js`（403 响应形态属 HTTP 呈现），内部改基于访问上下文 + `tokenHasScope`（自 `auth.js` 提取，`validateApiToken` 复用同一实现）。
- service 列表/搜索函数（`getSites` / `searchSites` / `listSitesByIds` / aiService）options 增加 `access` 对象，handler 调用面不再散传三布尔；布尔选项保留默认值兼容存量测试。
- `PRIVATE_BOOKMARK_CATEGORY` / `isPrivateBookmarkCategory` 留在 `privateBookmarkService.js`（迁移会造成 accessService ↔ privateBookmarkService 循环）。

## Consequences

- 新增鉴权凭据 / 新 cookie：只改 accessService 一处，edgeCache 零感知。

- 私人书签解锁分两层：`browserPrivateUnlocked`（admin 会话或私人书签 cookie，页面路由 go/home 用）与 `privateUnlocked`（再加有效 Bearer Token，API 读接口用）。**页面路由不授予 token 私人书签权限**——与迁移前 go.js / home.js 行为一致（ADR-0002 的 token 语义仅限 /api 读接口）。
- `siteLocked` 为懒求值字段：无消费者时零 KV 开销；锁门 handler 仍自行判定，上下文不重复读取锁状态。
- requireAdmin 的「弱 token + admin cookie → 403」优先级由 token 独立校验保证：`getAccessContext` 对带 Bearer 头的请求始终校验 token（不因 admin 会话短路）。
- token 语义不变（ADR-0002 编码进 `privateUnlocked` 判定）。
- KV 读次数不劣于现状：整站锁状态有 KV 缓存、上下文 WeakMap 去重、无 Bearer 头不发起 token 校验。
- 行为保持：弱 token + admin cookie → 403 的既有优先级；go.js 404 隐藏；`/submit/suggest-*` 三段鉴权舞蹈不动（属路由表重构领地）。

## 后续（2026-08-16，read-access-consolidation 收口）

- 读接口 `access` 参数优先于遗留布尔（`resolvedAccess = access || { adminAuthed, privateUnlocked }`）；布尔参数按兼容保留（存量测试零改动），未删除。
- `getAllSites` / `getSiteAnalytics` 收编 `access`：SQL 可见性片段与 getSites/searchSites 完全一致；`getSiteAnalytics` 缺省（null）按匿名过滤（接口级杜绝复漏）。home 页面传页面语义对象（`browserPrivateUnlocked`），JS `canList` 过滤删除；exportConfig 与 `/api/analytics/sites` 传 admin 上下文。
- chat 排行意图修复存量字段名 bug（`analytics.topHits` → `topByHits`）：排行分支此前恒为空、静默落回搜索；修复后访问上下文过滤对排行路径真实生效。
