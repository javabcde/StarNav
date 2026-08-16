# 站点核心分层与解环：siteCore 中立层 + 存量测试导入面冻结

2026-08-16 架构评审（improve-codebase-architecture）候选 1 实施收口。评审结论：ADR 0003-0007 收编了「模块归属」与「同一语义多实现」，但 siteService 的 re-export 垫片使模块图出现不可见环——siteService ↔ {submissionService, transferService} 双向依赖（re-export 不建图边，静态分析盲区），且新消费者（路由表资源模块）仍经垫片取共享原语，导入面脆弱（2026-08-16 曾发生导入面误删致 500 的回归）。

Status: accepted

## 决策要点

- **新建 `services/siteCore.js`（站点核心，中立叶层）**：收编 sites 表基础共享原语——`SITE_SELECT_COLUMNS`（规范行投影）、`applyVisibilityWhere`（可见性谓词应用）、`normalizeDuplicateUrlKey`（去重键）、`normalizeSitePayload`（载荷规范化）、`buildDuplicateError`（重复错误构造）、`getPrependSortOrder`（排序前置）、`findDuplicateSite`（重复点查）、`getAllSites`（全量读取）。本层只依赖 lib/utils、accessService、privateBookmarkService、spaceService、tagService，**不反向依赖** siteService/submissionService/transferService。
- **解环**：submissionService / transferService 的共享原语导入改指 siteCore；bookmarkSyncService、migrationService、home.js 的 `normalizeDuplicateUrlKey`/`getAllSites` 同步改指；路由表资源模块（api/resources/sites.js、analytics.js）的投稿/导入导出/重复点查符号改从真实模块（submissionService / transferService / siteCore）导入。模块图恢复单向：siteCore ← siteService/submission/transfer。
- **siteService 保留 re-export 垫片（含 submission/transfer 域符号）**：存量单元测试的 import 面冻结是硬约束（2026-08-16 起「不动既有测试」），垫片不再构成环（被垫模块不再反向 import siteService），继续作为测试与存量调用面的兼容层。删除垫片需先解除测试导入面冻结，属后续可选事项。
- **新增回归锁测试** `tests/siteCore.test.js`：垫片同一性（siteService 导出与 siteCore 同引用）+ 源码级无环断言（submission/transfer 不得 import siteService；siteCore 不得依赖三域）。

## Consequences

- **行为不变**：纯搬迁——函数体逐字保留（含 getAllSites 的 legacy 降级查询与 attachTags 容错），调用点语义零变化；全量测试（313 例）通过。
- **AI 导航性**：模块图无环，图查询（IMPORTS 边）与真实依赖一致；siteService 导出面不再含 submission/transfer 域符号的"真实归属"歧义。
- **后续**：服务端与插件的单一源豁免区收口（boolString/limitText/strictBoolString 收编 lib/utils、cookie 解析与 LANGUAGE_COOKIE 收编 lib/cookie、pwa.js 收编 hashString/textResponse 工厂、ROUTES↔discovery 一致性测试）随本 ADR 一并落地；api.js ROUTES 现为导出常量，供一致性测试消费。
