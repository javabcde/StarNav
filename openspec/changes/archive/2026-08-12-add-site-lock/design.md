## Context

StarNav 是 Cloudflare Workers + D1 + KV 的书签导航系统。当前所有前台能力（首页 `/`、跳转 `/go/*`、公开读 API）对匿名访客完全开放；认证只覆盖后台（`/admin` 管理员会话）和私人书签分类（独立密码）。部署者希望该实例仅自己可用，需要站点级门禁。

现有可复用件：
- `src/lib/auth.js`：PBKDF2 哈希（`hashPassword`/`verifyPasswordHash`）、Cookie 解析、IP 限速（`getLoginThrottle`/`registerLoginFailure`，5 次/15 分钟）、`parseCookies`。
- `src/services/privateBookmarkService.js`：KV token 解锁会话模式（随机 token 存 `NAV_AUTH`，Cookie 携带，TTL 选项 session/1h/12h/7d/30d）、时序安全比较。
- `src/pages/home/privateAccess.js`：全屏密码页 + 解锁表单（Tailwind CDN）渲染模式。
- `src/services/settingsService.js`：D1 `settings` 表 KV 读写。
- `src/lib/edgeCache.js`：`buildHomeCacheKey` 已有"鉴权 Cookie → 不缓存"名单（`SESSION_COOKIE_NAME`、`PRIVATE_ACCESS_COOKIE_NAME`）。

约束：
- 路由入口唯一拦截点：`src/index.js` 的 `routeRequest`（`handlePwaRequest` 在最前）。
- 首页带边缘缓存（Cache API），锁状态 Cookie 必须进缓存键排除名单。
- 白名单外的匿名请求不能依赖 401（页面要 302 到锁页）；API 匿名读在锁启用后 403。
- 无既有 OpenSpec specs；本变更新建 `site-lock` 能力。

## Goals / Non-Goals

**Goals:**
- 未解锁访客无法看到任何书签内容、无法跳转、无法调用读 API。
- 锁默认关闭；配置密码即生效，清除密码即关闭，存量部署升级无感知。
- 管理员会话免锁；解锁会话与私人书签密码互不授予。
- 锁 Cookie 不进入共享边缘缓存。

**Non-Goals:**
- 不做严格身份（非密码的强认证）；锁的语义是"知道密码的人可用"，不是"只有指定账号可用"。
- 不改私人书签密码机制（保持独立）。
- 不动定时任务（健康检查/备份）与 WebHook 出站。
- 不做部署层防护（Cloudflare Access/IP 白名单）——已评估，用户选择应用层密码锁。

## Decisions

1. **拦截点：`routeRequest` 层，PWA 路由之后、其余路由之前**。
   白名单（`/admin` 登录 GET/POST、`/static`、PWA 静态资源、`/api/settings/public`）直接放行；其余请求无解锁凭据时 302 到锁页。理由：单点拦截覆盖全部路由，不用改动每个 handler。备选（各 handler 内检查）拒绝——易漏、重复代码。

2. **锁密码存储：D1 `settings` key `site_lock_password`，PBKDF2 哈希**。
   与私人书签密码完全同构（含 `pbkdf2$` 前缀、100000 迭代、随机盐）。默认关闭 = 记录不存在/空值即不锁。备选：环境变量（改密码要重新部署）、复用管理员密码（语义混叠）——均拒绝。

3. **解锁会话：`nav_site_lock` Cookie + `NAV_AUTH` KV token（前缀 `site-lock:access:`）**。
   复用私人书签模式：解锁时生成随机 token 存 KV（TTL 对应时长），Cookie 带 `token|duration`；校验时查 KV。有效期选项 session/1h/12h/7d/30d，可主动退出（清 Cookie + 撤销 token）。理由：零新机制、与既有模式一致。

4. **管理员免锁：`isAdminAuthenticated` 为真即放行**。
   与私人书签"管理员直接可见"一致。后台会话是更强凭据；免锁避免已登录管理员再输一遍锁密码。

5. **API 策略：锁 Cookie 或有效 Bearer Token 通过；锁启用时匿名读 API 403**。
   在 `handleApiRequest` 入口统一判定（白名单 `settings/public` 除外）。浏览器插件带 Token 天然可用；WebHook 出站不受影响。备选：API 完全开放（锁形同虚设）——拒绝。

6. **试错限速：复用 `getLoginThrottle` 机制，独立 KV key（前缀 `site-lock:throttle:`）**。
   5 次失败锁 15 分钟，按 IP。与后台登录互不牵连。备选：共享计数（互相锁死）、不限速——拒绝。

7. **锁页：独立全屏页，复用私人密码页渲染模式**。
   被挡请求带 `?next=<原URL>`（仅同源 path 才接受，防开放重定向）；解锁成功 302 回跳。锁页本身可被边缘缓存（对所有人相同）。

8. **缓存隔离：`nav_site_lock` 加入 `buildHomeCacheKey` 的免缓存名单**。
   任一鉴权 Cookie（admin/私人/锁）存在即视为个性化请求，不进共享缓存。这是防"解锁页面泄漏给匿名访客"的硬约束。

9. **后台配置 UI：系统设置页新增「站点访问锁」分区**。
   密码框留空 = 不修改；显式「清除密码并关闭锁」按钮关闭。前后端校验 ≥4 位。设置保存后前台自动刷新（复用现有 `notifyFrontRefresh` 机制）。

10. **与私人书签关系：完全独立**。解锁整站 ≠ 解锁私人分类；两套 Cookie、两套 token、两套限速。

## Risks / Trade-offs

- **密码锁 ≠ 严格单人**：知道密码的人都能进。可接受（用户已选择），缓解：≥4 位校验、试错限速、锁页不渲染内容。若未来需要更强，可叠 Cloudflare Access，无需改代码。
- **缓存泄漏**：若未来有人把 `nav_site_lock` 从免缓存名单移除，解锁页面会进共享缓存。在 `buildHomeCacheKey` 处注释标明。
- **白名单 `/api/settings/public` 暴露品牌名/公告**：仅品牌信息，不含书签数据，可接受。
- **PWA 离线缓存**：锁启用前已缓存首页的浏览器离线仍可见旧内容——锁只保护新访客，不追溯已获权客户端，接受。
- **默认关闭的语义**：管理员可能误以为"配了密码就锁，删了密码就开"——设计已按此语义实现（密码即开关），并在 UI 文案说明。
