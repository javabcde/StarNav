## Why

解锁会话机制存在两份逐行平行的实现：`siteLockService.js`（303 行，整站锁）与 `privateBookmarkService.js`（私人书签密码）各自实现 PBKDF2 哈希（`bytesToBase64` / `timingSafeEqual` / `hashPassword` / `verifyPasswordHash` + 明文自动升级）、KV token 创建/滑动续期/撤销、时长映射（session/1h/12h/7d/30d）、Cookie 构建——siteLockService 注释自认「实现模式与 privateBookmarkService 保持一致」。PBKDF2 还有第三份拷贝在 `auth.js`（管理员密码，同为 `pbkdf2$` 前缀 + 100k 迭代）。时长词汇以硬编码 `<option>` 列表第 3、4 次出现在两个锁页（home/siteLock.js、home/privateAccess.js）。安全敏感机制没有单一测试 owner，改一处密码/续期语义需三处同步。

## What Changes

- `lib/crypto.js` 收编 PBKDF2 哈希段（`hashPassword` / `verifyPasswordHash` / `timingSafeEqual` / base64 编解码，含明文自动升级语义）；`siteLockService` + `privateBookmarkService` 改用它。实现期修正：`auth.js` 管理员密码为另一套 hex 双段格式（存储布局不兼容），保留自身实现——迁移会变更存储格式、破坏存量行为。
- 新建 `src/services/unlockSessionService.js`：`createUnlockSessionManager({ cookieName, tokenPrefix, settingKey, minPasswordLength, defaultPassword, ... })` 工厂，返回密码校验（含自动升级）、`createAccess` / `hasAccess`（滑动续期）/ `revokeCurrent`、`buildCookie` / `buildClearCookie`、时长 `normalize` / `getTtlSeconds` / 选项表。
- `siteLockService` / `privateBookmarkService` 各持一个实例，导出名与签名不变（存量 import 面零改动）；限速（仅整站锁）、锁状态 KV 缓存（仅整站锁）、`PRIVATE_BOOKMARK_CATEGORY`（ADR 0003 明确留驻）留在各自 adapter。
- 两个锁页的时长 `<select>` 改从时长选项表渲染，删除硬编码 `<option>` 列表。
- 新增核心模块单测（创建/校验/滑动续期/撤销/时长归一化，memory KV）；既有 siteLock / 私人书签测试经 adapter 导出面继续通过。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`——无新需求、无既有需求变更）。

### Modified Capabilities

无（既有 spec 无行为变更：解锁会话机制改经共享核心、锁页时长下拉渲染自同一词汇均属实现迁移）。
