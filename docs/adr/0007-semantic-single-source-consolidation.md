# 语义单一源收编：健康三态 JS 谓词、AI 设置域、健康/预览簇、分类子孙与颜色、cookie 解析与 Token 簇

2026-08-16 架构评审（improve-codebase-architecture）候选 1-7 实施收口。评审结论：ADR 0003-0006 收编的是**模块归属**，剩余摩擦集中在**「同一语义多实现」**——SQL 谓词收编后 JS 侧仍 4 份内联副本且已漂移、设置域有适配器先例而 AI 设置走了第二套更差约定、健康执行/预览抓取簇不依赖私有基建却留在 god 模块、分类子孙闭包三实现互称一致、cookie 解析双副本行为分歧、颜色校验双正则白名单分歧。

Status: accepted

## 决策要点

- **候选 1（健康三态 JS 谓词单一源）**：`healthQuery.js` 在 SQL 渲染器同文件补 `isDeadSite` / `isOkSite` / `isUnknownSite` 纯函数（与 deadSiteSql/okSiteSql/unknownSiteSql 逐字同义，NULL 状态码显式排除）。四处内联副本全部改调：siteService 搜索评分（siteService.js:196）、siteCard SSR 徽章（isUnhealthySite 变薄包装）、clientScript 与 adminJs 客户端镜像经**生成期内联函数源码**（`isDeadSite.toString()`）单一源化。
- **候选 2（AI 设置域）**：新建 `services/aiSettingsService.js`——`ai.*` 前缀、`DEFAULT_AI_SETTINGS`、`normalizeAiSettingsPayload`、批量读（listSettings 一次往返替代 6 次逐 key）、批量写（settingsService 新增 `setSettings`，D1 batch 一次往返）、密钥加解密（lib/crypto.js）收归一处；与 systemSettingsService 同构，第二个设置域使「settingsService 适配器 + 领域模块」接缝成为真实接缝。aiService/aiModelService 保留 re-export 垫片（ADR-0003 模式）；systemHealthService 与 settings 端点直连新模块，砍掉 systemHealthService → aiService 的 659 行重边。
- **候选 3（健康执行簇拆出）**：新建 `services/siteHealthService.js`（checkSiteHealth / bulkCheckSiteHealth / runScheduledHealthCheck / normalizeCheckUrl）。**不设 siteService 垫片**——本簇依赖 siteService.getSite，垫片会形成双向深循环（区别于 submission/transfer 的纯搬迁）。index.js 调度与 sites 端点直连。`normalizeIdList` 三份副本（siteService/iconService/新模块）收编进 lib/utils.js。
- **候选 4（预览抓取簇拆出）**：新建 `lib/sitePreview.js`（fetchSitePreview + meta 抽取），零 D1 依赖、与 lib/favicon.js 同族（两个抓取适配器 = 真实接缝）。siteService 保留 re-export 垫片（纯搬迁，无循环）。
- **候选 5（分类子孙闭包单一源）**：`categoryService.js` 收编三份实现——既有 `getDescendantCategoryIds`（id 集）+ 新增 `getDescendantCategoryNames`（name 集 CTE，含失败回退）+ 树遍历 `collectCategoryWithDescendants`（纯函数，供渲染路径复用内存树）；siteService.getSites 内联 CTE 与 home.js 树递归删除，改调本模块。
- **候选 6（cookie 解析 + Token 簇）**：新建 `lib/cookie.js` 统一 parseCookies（值 URL 解码、畸形序列回退原值不抛错、空键过滤——消弭 auth.js 不 decode / i18n.js decode 且抛 URIError 的分歧）；auth.js 与 i18n.js 改调。新建 `lib/apiTokenService.js` 收编 Token 簇（create/list/revoke/validate + hasBearerToken/tokenHasScope + 派生/脱敏），`constantTimeCompare` 迁入 lib/crypto.js；auth.js 保留 re-export 垫片（lib→lib，无方向违规），消费方（accessService / unlockSessionService / siteLock / api errors / admin 资源 / systemHealthService）全部直连。管理员会话并入 unlockSessionService 工厂维持 Speculative 不动（同 ADR-0006 后续）。
- **候选 7（分类颜色校验单一源）**：`categoryService.normalizeCategoryColor` 统一校验器（恶意载荷拒绝 + hex/rgba/hsla/linear-gradient/CSS 颜色名并轨），入库（cleanCategoryColor 变薄包装）与渲染（home/categories.js getCategoryCssColor 只做形态映射）共用一套正则。

## Consequences

- **行为修正（收编即修 bug）**：
  - 后台列表 `renderHealthStatus`：`last_checked_at` 有值而 `last_status_code` 为 NULL 的历史行（gap 态）从「异常」改为「正常」——SQL 三态中该行本不属于 dead/ok/unknown 任一态，旧 JS 因 `Number(null) → 0` 误判为异常；
  - 搜索评分与首页徽章同因 NULL 状态码不再误判 dead（与 SQL 过滤语义对齐）；
  - 分类入库校验放行此前被严格白名单拒绝的合法 CSS 颜色名（如 `rebeccapurple`）——渲染端历史上已放行，并轨取并集，恶意载荷拒绝面不变；
  - auth 端 cookie 值现在会 URL 解码（畸形序列回退原值）——会话/token 值均为安全字符集，实际行为无感知变化。
- **性能**：PUT /settings/ai 从约 17-18 次 D1 往返降至 3 次（getAiSettings 批量读 + setSettings 批量写 + 返回前回读一次）；getAiSettings 单读从 6 次串行降至 1 次。
- **导入面**：siteService/aiService/aiModelService/auth.js 保留 re-export 垫片（存量测试与调用方 import 面不变）；siteHealthService 因 getSite 反向依赖不设垫片，index.js 与 sites 端点已直连。
- **测试**：healthQuery.test.js 补 JS 谓词矩阵（含 NULL 状态码回归锁与三态互斥）；新增 sitePreview.test.js（6 例：抽取/归一/非 HTML/错误路径/截断）；新增 categoryService.test.js（树遍历 5 例 + 颜色校验 6 例，含两套旧白名单的分歧样本）；aiService.test.js 的 D1 mock 补批量读分发。
- **术语**：CONTEXT.md 新增「站点健康」「AI 接入」两节（站点健康三态 / AI 设置）。

## 后续

- siteService 仍为 ~1150 行：搜索/评分与 analytics 簇保留有据（共享私有查询基建 SITE_SELECT_COLUMNS/applyVisibilityWhere/attachTagsToSites，整簇搬迁需导出基建形成假拆分）——维持现状，不重开。
- 管理员会话并入 unlockSessionService 工厂（适配器 #3）仍为 Speculative（同 ADR-0006）。
- home 客户端脚本（clientScript.js ~46KB）整体不可单测：本次已把健康判定单一源化，但其余客户端逻辑仍为生成期内联字符串，如需深化可评估按 popup-logic.js 模式抽纯逻辑。
