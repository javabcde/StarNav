## 1. 密码学收编

- [x] 1.1 lib/crypto.js 新增 PBKDF2 段：`hashPassword` / `verifyPasswordHash`（`pbkdf2$sha256$iter$salt$hash` 五段格式、100k 迭代）/ `timingSafeEqual` / `isHashedPassword` / base64 编解码导出（自两个 service 迁入，逐字保留语义）
- [x] 1.2 实现期修正：auth.js **未**改调——其管理员密码为另一套 hex 双段格式（`pbkdf2$<salt>$<hash>`），与五段格式不兼容；迁移会变更存储格式、破坏存量测试与行为（零回归约束），auth.js 保留自身实现，crypto.js 注释明示不可混用
- [x] 1.3 siteLockService / privateBookmarkService 哈希段删除，改调 crypto.js（经 unlockSessionService re-export）

## 2. 解锁会话核心

- [x] 2.1 新建 `src/services/unlockSessionService.js`：`createUnlockSessionManager({ cookieName, tokenPrefix, settingKey, passwordFallback, requireEnabledCheck })` → `{ verifyPassword（含明文自动升级）, createAccess, hasAccess（滑动续期节流逐字保留）, revokeCurrent, clearAllTokens, buildCookie, buildClearCookie, normalizeDuration, getTtlSeconds, durationOptions（五档 + 默认标记） }`
- [x] 2.2 siteLockService：持实例，TTL 映射/哈希/token 机制删除；导出名与签名不变；限速 / 锁状态 KV 缓存 / `isSiteLockEnabled` / `updateSiteLockPassword` / `clearSiteLockPassword` 编排保留；密码即开关经 `requireEnabledCheck` + `enabledCheck`
- [x] 2.3 privateBookmarkService：持实例，机制删除；`PRIVATE_BOOKMARK_CATEGORY` / cookie 名 / 默认密码 / env fallback / `updatePrivateBookmarkPassword` 保留；实现期曾误删 `isPrivateBookmarkCategory` 导出（公共导入面），已补回并经语法检查 + 存量测试验证

## 3. 页面词汇

- [x] 3.1 home/siteLock.js 与 home/privateAccess.js 的时长 `<select>` 改从 adapter re-export 的 `durationOptions` 渲染（键/顺序/默认档单一来源；session 文案后缀属呈现层）

## 4. 测试

- [x] 4.1 新增 tests/unlockSessionService.test.js（10 项：create/has/滑动续期可观测/revoke/clearAll/时长归一化/密码校验与明文升级/enabledCheck/fallback）
- [x] 4.2 既有 tests/auth.test.js / siteLock.test.js / 私人书签相关测试全绿（adapter 导出面零改动验证）
- [x] 4.3 `npm run quality` 全绿（184/184：新增 unlock 10 项 + 锁页渲染 2 项，旧测试零改动）

## 5. 收尾

- [x] 5.1 语法检查全部改动文件（76 文件通过，quality 内含）
- [ ] 5.2 中文提交（git）
