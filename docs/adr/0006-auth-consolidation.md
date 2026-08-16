# 认证收编：PBKDF2 规范格式唯一化、IP 节流与会话策略共享

管理员密码哈希在 `auth.js` 保留了与 `crypto.js` 不兼容的第二套 hex 双段格式（`pbkdf2$<salt-hex>$<hash-hex>`），crypto.js 以「存储布局不兼容、勿迁移」注释维持该分支——新哈希永远以旧格式写入，分支只增不减；`getLoginThrottle`（auth.js）与 `getSiteLockThrottle`（siteLockService.js）除前缀与阈值外逐行相同，register/clear 半边已共享而 get 半边重复；管理员会话（auth.js）与解锁会话（unlockSessionService.js 工厂）各自手写同一套 Cookie 构建与滑动续期降频判定。三处重复均为「两份真实实现支撑同一概念」，收编后各剩一个。

Status: accepted

## 决策要点

- **密码哈希唯一实现 = `lib/crypto.js` 规范五段格式**（`pbkdf2$sha256$100000$<salt-b64>$<hash-b64>`）。`verifyAdminCredentials` 三态兼容：明文（历史）→ 旧 hex 双段（`pbkdf2$` 开头且 `split('$')` 为 3 段）→ 规范五段；明文与旧 hex 命中正确密码后均**原地升级为规范格式**写入 KV（沿用既有明文升级模式）。旧 hex 派生仅保留为 auth.js 私有 `legacyHashPasswordHex`，仅供旧值校验，禁止新写入。
- **行为修正**：存储为规范五段格式的管理员密码此前被旧逻辑误拒（只认 2 段 hex），现经 `crypto.verifyPasswordHash` 正常校验。
- **IP 节流共享**：新增 `lib/ipThrottle.js`——`createIpThrottle({ prefix, maxAttempts, lockoutSeconds })` 返回 `{ get, register, clear, maxAttempts }`；auth.js（`login_fail:`、5 次/15min）与 siteLockService.js（`site-lock:throttle:`、5 次/15min）各持实例，导出面（getLoginThrottle / registerLoginFailure / clearLoginFailures 及锁侧三函数）与 KV key 前缀、payload 形状 `{count, updatedAt}`、TTL 语义逐字保留。
- **会话策略共享**：新增 `lib/sessionPolicy.js` 纯函数——`buildSessionCookie(name, token, { maxAge, duration })`（Path=/、HttpOnly、SameSite=Strict、不设 Secure——夸克/VIA 注释保留；`duration==='session'` 不写 Max-Age）与 `shouldRenew({ createdAt, refreshedAt, ttlMs, now })`（剩余不足半窗口才续期写）。策略参数（cookie 名 / 默认 Max-Age / TTL / 7d 绝对上限）留在调用方：admin 12h 半窗 + 7d 上限、解锁按 payload ttl 语义均不变。
- 新模块放 `src/lib/`：同为 lib(auth.js) 与 services(siteLockService/unlockSessionService) 两层消费的纯基础设施，与 crypto.js 同层。

## Consequences

- 新增密码哈希只有一种格式；未来格式升级只需改 crypto.js 一处并保留旧格式读取（与 ADR-0003 的「只改 accessService 一处」同构）。
- 登录成功时的一次性升级写 KV：明文/旧 hex 用户首次登录各多一次 KV 写，此后不再发生。
- 管理员密码验证路径（明文→hex→规范三态）纳入 tests/auth.test.js；节流实例与前缀隔离、会话策略纯函数均有测试覆盖。
- 行为保持面：KV key 布局、节流 payload/TTL/锁定边界、admin 会话滑动续期与绝对上限、解锁会话续期锚点（createdAt 缺失保守续期）、Cookie 属性集——全部不变；仅 Cookie 属性串的排列顺序统一（浏览器语义无关）。
- 覆盖范围：本次只收编密码哈希、IP 节流、Cookie/续期三处；管理员会话并入 unlockSessionService 工厂（适配器 #3）仍为 Speculative，未做——两种会话的 TTL/上限语义差异需要工厂进一步参数化，留待真实需求出现。

## 后续

- 2026-08-16，候选 7（auth.js 堆）实现收口：crypto.js:26-28 的「勿迁移」注释已改写为合并说明；`generateSalt` / `getClientIp` 私有副本删除。
