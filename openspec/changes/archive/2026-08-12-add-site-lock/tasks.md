## 1. SiteLock 服务层

- [x] 1.1 新建 `src/services/siteLockService.js`：锁密码读写（`site_lock_password` 存 D1 settings，PBKDF2 复用 `lib/auth.js` 哈希）、≥4 位校验、`isSiteLockEnabled` 判定（记录缺失/为空 = 关闭）
- [x] 1.2 解锁会话：随机 token 生成、KV 存储（`NAV_AUTH` 前缀 `site-lock:access:`，TTL 对应时长）、`nav_site_lock` Cookie 构建/清除、`normalizeSiteLockDuration`（session/1h/12h/7d/30d，复用 private 模式）
- [x] 1.3 解锁校验：`hasSiteLockAccess(request, env)`（Cookie token 查 KV + 时序安全比较）、`verifySiteLockPassword(env, password)`、`revokeCurrentSiteLockAccess`
- [x] 1.4 试错限速：复用 `getLoginThrottle`/`registerLoginFailure` 机制，独立 KV key 前缀 `site-lock:throttle:`，5 次/15 分钟

## 2. 路由接入

- [x] 2.1 `routeRequest` 拦截：PWA 路由之后、其余路由之前；白名单（`/admin` 登录 GET/POST、`/static`、PWA 静态资源、`/api/settings/public`）放行，其余无解锁凭据 302 到锁页（带同源 `?next=`）
- [x] 2.2 锁页渲染 `renderSiteLockPage`：全屏密码页（复用 `renderPrivateBookmarkPasswordPage` 模式），i18n 中英文案加入 `i18n.js`
- [x] 2.3 锁页 POST 处理：限速检查 → 密码验证 → 种 Cookie（`createSiteLockAccess`）→ 同源回跳 `next`（非同源回 `/`）→ 失败重渲锁页带错误
- [x] 2.4 `handleApiRequest` 入口凭据判定：白名单外 API 需锁 Cookie 或有效 Bearer Token 或管理员会话，否则 403
- [x] 2.5 `buildHomeCacheKey` 免缓存名单加入 `nav_site_lock`（注释标明防泄漏硬约束）

## 3. 后台设置 UI

- [x] 3.1 系统设置页新增「站点访问锁」分区：密码设置框（留空 = 不修改，前后端 ≥4 位校验）、「清除密码并关闭锁」显式按钮、当前状态展示
- [x] 3.2 后台 API：锁密码保存/清除端点（复用 settings 读写模式），保存后 `notifyFrontRefresh` 通知前台刷新
- [x] 3.3 后台 JS 绑定新分区表单（对齐现有 `scripts/index.js` 模式）

## 4. 验证与文档

- [x] 4.1 新增 `tests/siteLock.test.js`：默认关闭、配置后 302/403、解锁回跳、同源校验、限速锁定、退出解锁、缓存名单断言（对齐现有 node:test 风格）
- [x] 4.2 运行 `npm test` 与 `scripts/check-syntax.js` 全绿
- [x] 4.3 README 核心特性与 docs 更新（整站锁能力、默认关闭语义、白名单说明）
