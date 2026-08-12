## ADDED Requirements

### Requirement: 整站锁默认关闭，密码即开关

整站锁 SHALL 默认不生效。管理员在后台设置页配置站点访问锁密码（PBKDF2 哈希存储，最少 4 位）后，除白名单路由外的所有路由均 SHALL 需要解锁凭据；清除密码即恢复全开放。

#### Scenario: 未配置密码时站点保持开放
- **WHEN** `site_lock_password` 设置不存在或为空，访客请求 `/`
- **THEN** 正常渲染首页，无任何锁页跳转

#### Scenario: 配置密码后匿名访问被挡
- **WHEN** 管理员已设置锁密码，匿名访客请求 `/`、`/go/123` 或任意读 API
- **THEN** 请求 302 到全屏锁页；API 请求返回 403

#### Scenario: 清除密码后恢复开放
- **WHEN** 管理员在后台执行「清除密码并关闭锁」
- **THEN** `site_lock_password` 被删除，后续匿名请求不再被挡

#### Scenario: 密码长度不足被拒绝
- **WHEN** 管理员设置少于 4 位的锁密码
- **THEN** 保存失败并提示最少 4 位

### Requirement: 白名单路由免解锁

以下路由 SHALL 在锁启用时仍可匿名访问：`/admin` 登录页与登录 POST、`/static` 静态资源、PWA 静态资源（manifest/Service Worker/图标）、`/api/settings/public`。

#### Scenario: 锁启用后仍可登录后台
- **WHEN** 锁已启用，未解锁访客请求 `GET /admin`
- **THEN** 返回后台登录页（不跳锁页）；登录 POST 正常处理

#### Scenario: PWA 资产不受锁影响
- **WHEN** 锁已启用，请求 manifest/SW/图标路径
- **THEN** 正常返回，无需解锁

### Requirement: 管理员会话免锁

已登录的管理员会话（`isAdminAuthenticated` 为真）SHALL 可访问全部路由，无需解锁会话。

#### Scenario: 已登录管理员绕过锁
- **WHEN** 锁已启用，携带有效管理员会话 Cookie 的请求访问 `/`、`/go/*`、`/api/*`
- **THEN** 正常处理，无锁页跳转、无 403

### Requirement: 解锁会话

输入正确锁密码后 SHALL 获得解锁会话：`nav_site_lock` Cookie + `NAV_AUTH` KV token。有效期选项 SHALL 为：仅本次会话、1h、12h、7d、30d；可主动退出（清除 Cookie 并撤销 token）。

#### Scenario: 正确密码解锁并回跳
- **WHEN** 访客在锁页提交正确密码，且锁页 URL 带同源 `?next=/go/123`
- **THEN** 302 到 `next` 地址，并种下解锁 Cookie

#### Scenario: 错误密码显示错误
- **WHEN** 访客在锁页提交错误密码
- **THEN** 重新渲染锁页并显示密码错误提示，不种任何 Cookie

#### Scenario: 解锁会话过期后重新被挡
- **WHEN** 解锁 Cookie 携带的 token 在 KV 已过期或不存在
- **THEN** 请求被当作未解锁处理（302 到锁页）

#### Scenario: 退出解锁
- **WHEN** 已解锁访客执行「退出解锁」
- **THEN** 解锁 Cookie 被清除、KV token 被撤销，后续请求回到锁定状态

#### Scenario: 回跳地址非同源被拒绝
- **WHEN** `?next=` 指向其他来源的绝对 URL（如 `https://evil.example`）
- **THEN** 解锁成功后回跳首页 `/`，不回跳到外部地址

### Requirement: API 凭据策略

锁启用时，API 调用 SHALL 需携带有效解锁 Cookie 或有效 Bearer Token（管理员会话亦有效）；匿名读 API SHALL 返回 403。锁禁用时 API 行为与现状一致。

#### Scenario: 锁启用后 Token 客户端可用
- **WHEN** 锁已启用，请求带有效 Bearer Token 调用 `/api/config`
- **THEN** 正常返回数据，不要求锁 Cookie

#### Scenario: 锁启用后匿名读 API 被拒
- **WHEN** 锁已启用，无任何凭据请求公开读 API（如 `/api/config`）
- **THEN** 返回 403

### Requirement: 试错限速

锁密码验证 SHALL 按客户端 IP 限速：5 次失败锁定 15 分钟；计数与后台登录独立。

#### Scenario: 连续输错被锁定
- **WHEN** 同一 IP 在 15 分钟内连续 5 次提交错误密码
- **THEN** 锁页显示"尝试过于频繁，请 15 分钟后再试"，拒绝继续验证

#### Scenario: 锁限速不影响后台登录
- **WHEN** 某 IP 因锁密码失败被限速，随后尝试后台登录
- **THEN** 后台登录正常走自己的计数，不受锁限速影响

### Requirement: 边缘缓存隔离

`nav_site_lock` Cookie SHALL 视为鉴权 Cookie：`buildHomeCacheKey` 检测到任一鉴权 Cookie（管理员会话、私人书签访问、整站锁）即不命中共享缓存。

#### Scenario: 解锁页面不进入共享缓存
- **WHEN** 已解锁访客请求首页（带 `nav_site_lock` Cookie）
- **THEN** 页面不走共享缓存，渲染结果不污染缓存

#### Scenario: 锁页可被缓存
- **WHEN** 锁已启用，匿名访客请求首页
- **THEN** 锁页作为该状态下唯一渲染结果正常写入共享缓存（对所有匿名访客一致）
