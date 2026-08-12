## Why

部署后的站点完全公开：首页、`/go` 跳转、公开读 API 任何人可访问。部署者希望该实例仅自己使用，需要一道"打开就能看到内容"之前的门禁——整站锁。

## What Changes

- 新增整站锁能力：在 `routeRequest` 层拦截，除白名单路由外的所有路由（`/`、`/go/*`、`/api/*`、`/admin`）未解锁时一律 302 到全屏锁页。
- 锁密码存 D1 `settings`（`site_lock_password`，PBKDF2 哈希），后台系统设置页可配置；**默认关闭**——未配置密码即不锁，配置密码即生效（存量部署升级不受影响）。
- 解锁会话：输对密码后种 Cookie + KV token（`NAV_AUTH`），有效期仅本次会话/1h/12h/7d/30d，可主动退出；解锁后同源回跳原请求地址。
- 管理员会话免锁；解锁会话与私人书签密码保持独立，互不授予。
- API 策略：锁 Cookie 或有效 Bearer Token 可调用 API；锁启用后匿名读 API 返回 403；WebHook 为服务端出站不受影响。
- 白名单路由：`/admin` 登录页与登录 POST、PWA 静态资源（manifest/SW/图标）、`/api/settings/public`。
- 试错限速：复用 IP 限速机制、独立计数（5 次失败锁 15 分钟）。
- 边缘缓存：锁 Cookie 加入 `buildHomeCacheKey` 的"鉴权 Cookie → 不缓存"名单，防止解锁页面泄漏给共享缓存。
- 密码强度：设置时前后端均校验最少 4 位；关闭锁为显式操作（留空不修改 + 「清除密码并关闭锁」按钮）。

## Capabilities

### New Capabilities

- `site-lock`: 站点级访问门禁——密码配置、解锁会话、白名单路由、API 凭据策略、试错限速与边缘缓存隔离。
