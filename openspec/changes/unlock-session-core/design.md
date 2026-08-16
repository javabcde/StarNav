## Context

- siteLockService.js（303 行）：`SITE_LOCK_COOKIE_NAME = 'nav_site_lock'`、token 前缀 `site-lock:access:`、密码 setting key `site_lock_password`、`SITE_LOCK_TTL_OPTIONS`（session/1h/12h/7d/30d）、`normalizeSiteLockDuration` / `getSiteLockAccessTtlSeconds`、`createSiteLockAccess` / `hasSiteLockAccess`（滑动续期）/ `revokeCurrentSiteLockAccess`、`buildSiteLockAccessCookie` / `buildClearSiteLockAccessCookie`、`verifySiteLockPassword`（明文自动升级）；自实现 `bytesToBase64` / `base64ToBytes` / `timingSafeEqual` / `isHashedPassword` / `hashPassword` / `verifyPasswordHash`；限速复用 auth.js 的 `registerLoginFailure`（key 前缀不同）；另有锁状态 KV 缓存（`site_lock:enabled` + TTL 60s）。
- privateBookmarkService.js（7.2KB）：`PRIVATE_ACCESS_COOKIE_NAME = 'nav_private_bookmarks_access'`、前缀 `private-bookmarks:access:`、setting key `private_bookmarks_password`、`PRIVATE_ACCESS_TTL_OPTIONS` 同 5 档、同组自实现哈希 helpers（逐行同构）、`createPrivateBookmarkAccess` / `hasPrivateBookmarkAccess` / `revokeCurrentPrivateBookmarkAccess` / `buildPrivateBookmarkAccessCookie` / `verifyPrivateBookmarkPassword`；另含 `PRIVATE_BOOKMARK_CATEGORY = '私人书签'`（ADR 0003 明确留驻本文件，避免 accessService 循环）。
- auth.js：管理员密码哈希（`PASSWORD_HASH_PREFIX = 'pbkdf2$'`、100k 迭代、PBKDF2-SHA256、明文自动升级）——第三份 PBKDF2 实现；tests/auth.test.js 覆盖良好。
- 时长词汇硬编码第 3、4 份：home/siteLock.js:46-47 与 home/privateAccess.js:16-17,49-50 的 `<option>` 列表。
- lib/crypto.js 现状：AES-GCM（SECRET_KEY 加解密）。

## Goals / Non-Goals

**Goals:**
- 解锁会话机制（密码哈希、token 生命周期、时长词汇、Cookie 构建）单一 owner，可单测。
- 三份 PBKDF2 收敛为一份；两个锁页时长下拉渲染自同一词汇。

**Non-Goals:**
- 不合并整站锁与私人书签的凭据语义：cookie 名、token KV 前缀、setting key、限速、锁状态缓存、`PRIVATE_BOOKMARK_CATEGORY` 全部留在各自 adapter。
- 不改滑动续期、TTL、明文升级、Cookie 属性的任何行为（逐字保留）。
- 不把写侧状态转移收进 accessService（ADR 0003 边界不动）。

## Decisions

### D1：参数化工厂 `createUnlockSessionManager`
`unlockSessionService.js` 导出工厂：`createUnlockSessionManager({ cookieName, tokenPrefix, settingKey, minPasswordLength = 4, defaultPassword = null })` → `{ verifyPassword, createAccess, hasAccess, revokeCurrent, buildCookie, buildClearCookie, normalizeDuration, getTtlSeconds, durationOptions }`。siteLockService / privateBookmarkService 各持实例（模块级常量），导出名与签名不变——存量 import 面（handlers、pages、tests）零改动。
- 替代：只抽哈希段到 crypto——token 机制仍两套平行，只解决三分之一。

### D2：PBKDF2 哈希段收编 `lib/crypto.js`，两处全改（实现期修正）
`hashPassword` / `verifyPasswordHash`（五段格式 `pbkdf2$sha256$<iter>$<salt-b64>$<hash-b64>`、100k 迭代、明文自动升级入口）/ `timingSafeEqual` / `isHashedPassword` / base64 编解码迁入 crypto.js（与 AES-GCM 同居）；siteLockService、privateBookmarkService 全部改调。
**auth.js 保留自身实现**：管理员密码为 hex 双段格式（`pbkdf2$<salt>$<hash>`），与五段格式**存储布局不兼容**——原「三处拷贝」前提有误；迁移会变更管理员密码存储格式、破坏存量测试与行为（零回归约束）。crypto.js 注释明示两格式不可混用。
- 替代：哈希只进 unlockSessionService——密码学知识仍两处；auth.js 一并改调——变更管理员密码存储格式，违反零回归约束。

### D3：adapter 边界
核心参数化实例 + adapter 本地策略：
- siteLockService adapter：`nav_site_lock`、`site-lock:access:`、`site_lock_password`、限速（auth.js 计数）、锁状态 KV 缓存、`updateSiteLockPassword` / `clearSiteLockPassword` / `isSiteLockEnabled` 的 D1/settings 编排。
- privateBookmarkService adapter：`nav_private_bookmarks_access`、`private-bookmarks:access:`、`private_bookmarks_password`、`DEFAULT_PRIVATE_PASSWORD`、`PRIVATE_BOOKMARK_CATEGORY`、`updatePrivateBookmarkPassword` / `clearPrivateBookmarkAccessTokens` 的编排。
- 两 service 保留全部既有导出（re-export 或薄委托）。

### D4：锁页时长下拉渲染自词汇
core 导出 `durationOptions`（键/标签/默认档位）；home/siteLock.js 与 home/privateAccess.js 的 `<select>` 从 adapter re-export 的选项渲染，删除硬编码 `<option>` 列表。
- 替代：保留硬编码——时长词汇继续 4 处。

## Risks / Trade-offs

- **auth.js 密码路径**：改动敏感但测试覆盖好；改后先跑 auth.test.js 全绿再合入。
- **滑动续期语义**：hasAccess 的「续期写节流」逐字保留——核心测试用 memory KV 断言续期前后 TTL 变化。
- **默认密码差异**：私人书签有 `DEFAULT_PRIVATE_PASSWORD = '123456'`、整站锁无——工厂参数化覆盖，不归一行为。
- **import 面**：两个 adapter 导出名保持原样，handlers/pages/tests 零改动面；核心不 import 任何 service（无循环）。
