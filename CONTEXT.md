# StarNav

个人/团队书签导航系统（Cloudflare Workers + D1 + KV）。本文档记录站点访问控制领域的术语；实现细节见代码与 ADR。

## 访问控制

**整站锁 (Site Lock)**:
部署级访问门禁。未配置密码时默认关闭（不生效）；配置密码后，除白名单路由外的所有路由都需要解锁会话或管理员会话才能访问。
_Avoid_: 全站锁、站点密码

**解锁会话 (Unlock Session)**:
访客输入整站锁密码后获得的临时访问凭据（Cookie + KV token），有效期可选 仅本次会话 / 1h / 12h / 7d / 30d，可主动退出。解锁整站不等于解锁私人书签分类。
_Avoid_: 登录会话、解锁状态

**管理员会话 (Admin Session)**:
后台管理员登录后建立的会话。可免锁访问全站，并可查看私人书签分类。
_Avoid_: 登录态、后台会话

**私人书签密码 (Private Bookmark Password)**:
解锁固定分类「私人书签」的访问密码，独立于整站锁；管理员会话可绕过。
_Avoid_: 二级密码、书签密码

## 路由

**白名单路由 (Allowlisted Routes)**:
整站锁启用后仍无需解锁即可访问的路由：`/admin` 登录页与登录 POST、PWA 静态资源（manifest / Service Worker / 图标）、`/api/settings/public`。访问其他被挡路由一律 302 到锁页。
_Avoid_: 例外路由、免锁路由
