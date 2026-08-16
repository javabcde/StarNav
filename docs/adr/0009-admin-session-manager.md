# 管理员会话并入会话工厂：unlockSessionService 双 kind + auth.js 收口为垫片

2026-08-16 架构评审（improve-codebase-architecture）候选 5 实施收口。ADR 0006/0007 将「管理员会话并入 unlockSessionService 工厂」记为 Speculative；本评审新增证据：siteLock/privateBookmark 两 adapter 的透传宽度使工厂接缝导出面翻倍，且管理员会话是第三套并行会话实现（payload 形状 `{createdAt[,lastRefresh]}` vs `{createdAt,duration,ttl}`），新增会话类型或改续期策略需动多处。

Status: accepted

## 决策要点

- **`unlockSessionService.js` 新增 `createAdminSessionManager()` 工厂**（与 `createUnlockSessionManager` 同族的第二种会话 kind）：参数化 cookieName/tokenPrefix/ttlSeconds/absoluteTtlSeconds，默认值即现行策略（`nav_admin_session`、`session:` 前缀、12h 滑动半窗节流、7d 绝对上限、payload `{createdAt, lastRefresh}`、请求级 WeakMap 鉴权缓存）。机制词汇（parseCookies / sessionPolicy.buildSessionCookie / shouldRenew）与解锁会话共用同一导入面。
- **单例具名导出**：`SESSION_COOKIE_NAME` / `buildSessionCookie` / `createAdminSession` / `refreshAdminSession` / `destroyAdminSession` / `validateAdminSession` / `isAdminAuthenticated`，与 lib/auth.js 历史导出面逐名一致。
- **lib/auth.js 收口为密码/限速域 + 垫片**：会话簇（常量、五函数、WeakMap）删除，改 re-export `../services/unlockSessionService.js`；密码哈希（verifyAdminCredentials + 旧格式升级）、登录限速（ipThrottle 绑定）与 API Token/cookie 垫片保留。lib→services 边有 edgeCache→accessService 先例（单一源消费）。
- **生产消费方直连**：handlers/admin.js、handlers/siteLock.js、services/accessService.js 的会话符号改从 unlockSessionService 导入（密码/限速仍走 lib/auth.js）。
- **新增回归测试** `tests/adminSessionManager.test.js`：工厂行为（创建/校验/滑动续期节流/绝对过期销毁/WeakMap 缓存单读 KV）+ 垫片同一性（auth.js 与单例同引用）。

## Consequences

- **行为不变**：函数体逐字搬迁；存量 auth.test.js（经 auth.js 垫片面）与全部鉴权消费方测试零改动通过（全量 360 例）。
- **会话机制单点化**：KV token 生命周期 / 滑动续期 / Cookie 构建词汇集中在 unlockSessionService；新增会话 kind 只需再参数化一个工厂。
- **接口宽度收敛**：管理员会话不再是第三套实现；auth.js 导出面从 ~19 项（会话+密码+限速+垫片）收缩为密码/限速 + 纯垫片。
- **后续**：siteLock/privateBookmark 两 adapter 的透传宽度（~14/~13 项）维持现状——它们是「真实接缝两适配器」形态的合法消费方，瘦身需等工厂接口按消费模式收敛，单独评估。
