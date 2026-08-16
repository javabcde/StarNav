# StarNav

个人/团队书签导航系统（Cloudflare Workers + D1 + KV）。本文档记录站点访问控制、书签同步、插件站内浏览、站点健康与 AI 接入领域的术语；实现细节见代码与 ADR。

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
解锁固定分类「私人书签」的访问密码，独立于整站锁；管理员会话可绕过。有效 Bearer Token 同样授予私人书签读取（token 即密码级凭据）。
_Avoid_: 二级密码、书签密码

**访问上下文 (Access Context)**:
描述单个请求访问等级的组合判定结果：管理员会话、有效 Bearer Token（含 scope）、私人书签解锁、整站锁解锁四类凭据的并集，以及由此推出的站点可见性判定与共享缓存可用性。由访问控制模块在请求入口一次性推导，消费方（handlers、services、边缘缓存）只接收结果，不再各自重推规则。
_Avoid_: 权限对象、鉴权结果、访问状态

## 路由

**白名单路由 (Allowlisted Routes)**:
整站锁启用后仍无需解锁即可访问的路由：`/admin` 登录页与登录 POST、PWA 静态资源（manifest / Service Worker / 图标）、`/api/settings/public`。访问其他被挡路由一律 302 到锁页。
_Avoid_: 例外路由、免锁路由

## 站点属性

**站点图标 (Site Icon)**:
站点在书签卡片/列表中的 favicon，存储于 `sites.logo` 字段（图标源 URL 字符串）。空值即"无图标"。自动补全与手动批量刷新均只写此字段。站点数据中简称 logo（字段名），术语统一为"站点图标"。
_Avoid_: icon、favicon

**图标自动补全 (Icon Auto-Fill)**:
站点无图标时，从点击路径（主站 `/go/:id` 跳转、插件站内浏览点击）触发的一次性后台补全：`getFavicon` 抓取成功则写回 `logo`，抓取失败则以 KV 标记 `favicon:failed:{id}` **永久放弃**——自动路径不再重试，只有手动操作（admin 批量刷新图标、编辑书签）才清标记重置。补全不阻塞跳转/打开，失败静默。
_Avoid_: 图标刷新、favicon 重试


## 站点健康

**站点健康三态 (Site Health)**:
站点链接可访问性的检测结果三态：**正常 (ok)**（无错误且状态码 2xx/3xx）、**异常 (dead)**（记录过错误，或状态码已知且 <200 / >=400）、**未检测 (unknown)**（从未检测，`last_checked_at` 为空）。判定语义单一源在 `healthQuery.js`——SQL 谓词渲染与 JS 谓词同文件相邻，消费方（列表过滤、搜索评分、徽章、后台列表）禁止手写副本。「已检测但无状态码」为三态皆否的 gap 态（历史数据可能存在），不误判为异常。
_Avoid_: 链接检测、健康状态、异常链接判定

## AI 接入

**AI 设置 (AI Settings)**:
`ai.*` 键域设置（启用开关 / 模型 / 密钥 / 提示词等）。域逻辑单一源在 `aiSettingsService.js`，与 `systemSettingsService` 同构（适配器 `settingsService` + 领域模块）；编排（aiService）与系统健康聚合（systemHealthService）只消费不重推。密钥加密存储在 `lib/crypto.js`（`enc:v1:` 前缀）。
_Avoid_: AI 配置、模型设置、AI 参数

## 书签同步

**书签同步 (Bookmark Sync)**:
一键同步功能：以浏览器收藏为事实源，把 StarNav 中同步来源书签完全对齐（新增、改标题/URL/分类、删除）。手动书签不参与。入口双轨：扩展一键（`chrome.bookmarks`）与后台 bookmarks.html 文件上传，共用同一后端对齐管线。
_Avoid_: 增量导入、书签导入、一键导入

**浏览器书签 (Browser Bookmark)**:
外部实体：浏览器收藏夹中的条目（标题、URL、文件夹路径、浏览器侧稳定 ID）。它是同步的事实源，同步按点击时的全量快照执行。
_Avoid_: 收藏夹条目

**同步书签 (Synced Bookmark)**:
`sync_source = browser` 的站点。由书签同步写入，参与对齐，可被浏览器状态覆盖或删除。用户在 StarNav 里的手动编辑不保护它（浏览器赢）。
_Avoid_: 同步来源项、云端书签

**手动书签 (Manual Bookmark)**:
`sync_source = manual` 的站点。后台手动添加、扩展单条收藏、现有 JSON/CSV 导入与备份恢复产生。永不参与对齐：不被更新、不被删除，且其 URL 去重键挡住同名浏览器书签的插入。
_Avoid_: 本地书签、自有书签

**解除同步 (Unsync)**:
把某条同步书签转为手动书签的动作（`sync_source` 置 manual 并清除浏览器 ID），此后不再参与对齐。
_Avoid_: 取消同步、退出同步

**对齐 (Alignment)**:
同步执行时的调和过程：以浏览器快照为准计算增/改/删差异。字段范围仅 name、url、分类；visibility、排序、访问次数、描述等 StarNav 本地属性不动。

**去重键 (URL Key)**:
URL 规范化后的配对与查重依据：去 `www`、尾斜杠、大小写，保留 query，http/https 视为同键。同步用 URL Key 为主匹配键，扩展路径以浏览器书签 ID 辅助（URL 被改时原地更新）；多浏览器按 URL 合并、后同步者覆盖。
_Avoid_: 规范化 URL、url_key

## 插件站内浏览

**站内书签浏览 (In-Site Browsing)**:
在浏览器插件弹窗中浏览 StarNav 站内书签——搜索、分类筛选、列表点击打开，无需打开网站。与「浏览器书签」严格区分：浏览读的是站内数据，一键同步读的是浏览器收藏夹。点击书签直接打开原始 URL（外部新标签），不经过站内 `/go` 跳转，故不计数。
_Avoid_: 收藏夹浏览、插件浏览

**全量缓存 (Full Cache)**:
插件站内浏览的本地缓存格式（`browse:cache:v1`）：`{ kind: 'full', fetchedAt, ttlMinutes, items, total, categories }`，存于 `chrome.storage.local`，popup 与 background 共用（预热写入、浏览渲染、图标补全本地 patch 同一份数据）。形状/键名契约由 `extension-contract.js` 持有，形状判定与过滤分页逻辑在 `popup-logic.js`。旧格式（无 `kind: 'full'`）视为无效、首次打开重建。
_Avoid_: 浏览缓存、缓存格式

## 站点域分层

**站点核心 (Site Core)**:
sites 表基础共享原语的中立层，单一持有在 `services/siteCore.js`：规范行投影（SITE_SELECT_COLUMNS）、可见性谓词应用、载荷规范化、去重键、重复点查、排序前置、全量读取。站点 CRUD（siteService）、投稿域（submissionService）、导入导出域（transferService）共同消费，本层不反向依赖三者——模块图保持单向。siteService 保留同名 re-export 垫片维持存量测试与调用方导入面（决策见 ADR-0008）。
_Avoid_: 站点基础服务、共享 helper 层

**布尔字符串归一 (Boolean String Normalization)**:
设置存储值（字符串 'true'/'1'/'yes'/'on' 等）到布尔字符串的归一语义，单一持有在 `lib/utils.js`：宽松版 `boolString`（backup/sys settings 域共用，'1'/'true'/'yes'/'on' 均视为 true，空值回退 fallback）、严格版 `strictBoolString`（AI 设置域，仅字面量 'true' 视为 true，未知值不激活功能）。禁止在设置域内再写第三份判定。
_Avoid_: parseBool、布尔解析

## 页面客户端

**客户端纯逻辑 (Client Pure Logic)**:
首页与后台客户端脚本的共享纯函数，单一持有在 `pages/clientLogic.js`：HTML 转义、URL 归一、关键词高亮、AI 文本归一、搜索历史合并，以及后台分析/同步/备份/Token 簇（heatLevel、formatPeak、getAnalyticsScores、normalizePickerColor、formatBytes、webdavStatusText、formatTokenScopes、同步渲染族、normalizeAiAdminItems）。经 `toString()` 生成期内联进客户端模板（首页 String.raw / 后台 adminJs），同一份源码被 node:test 直接单测；内联前提是函数体不含反引号与 `${`（clientScript.js 模块加载探针 + tests/clientLogic.test.js / tests/adminClientLogic.test.js 回归锁守护）。函数体引用的自由符号（escapeHTML 别名、weekdayNames）须在模板作用域同名存在。卡片渲染等依赖生成期契约插值（CARD_CONTRACT）的逻辑留在模板内，不抽。
_Avoid_: 客户端工具函数、内联脚本逻辑

**投稿分析 (Submission Analytics)**:
投稿审核域的分析计算分层：per-metric D1 查询编排留在 `submissionService.getSubmissionAnalytics`，纯聚合（日序列补齐、7×24 热力、质量指标、域名聚合、趋势/异常、审核压力、审核窗口、日历分级）单一持有在 `services/submissionAnalytics.js`（`SUBMISSION_EVENTS_SQL` 双源并集同址），零 D1 依赖、node:test 直接单测。`getPendingSites` 主查询 → legacy 降级（仅 pending 态）→ 空结果的三层回退梯由 tests/getPendingSites.test.js 锁定。
_Avoid_: 投稿统计、提交分析逻辑

**会话工厂 (Session Factory)**:
访问凭据会话机制的单一持有点，`services/unlockSessionService.js`：`createUnlockSessionManager`（解锁会话：整站锁/私人书签两 adapter 各持实例）与 `createAdminSessionManager`（管理员会话：12h 滑动半窗节流 + 7d 绝对上限 + 请求级 WeakMap 缓存）两个参数化工厂。KV token 生命周期、滑动续期（shouldRenew）、Cookie 构建（sessionPolicy）词汇集中于此；`lib/auth.js` 收口为密码/限速域并保留会话 re-export 垫片（决策见 ADR-0009）。
_Avoid_: 会话工具、session 管理

**搜索评分 (Search Scoring)**:
搜索相关性评分的纯逻辑域，单一持有在 `services/searchScoring.js`：查询解析（parseSearchQuery，含 tag:/cat:/url:/is: 筛选与 CJK ngram 扩展）、高级筛选谓词（matchesAdvancedFilters）、评分管线（scoreSite，权重与匹配理由词汇）。零 D1 依赖，行为矩阵在 tests/searchScoring.test.js 直接单测；`siteService.searchSites` 只消费导出（_score/_matchedFields/_matchReasons 输出形状是跨模块契约，aiService 亦消费）。评分权重/匹配理由修改只改本模块。
_Avoid_: 搜索评分逻辑、评分函数

**WebDAV 传输 (WebDAV Transport)**:
备份域的 WebDAV 适配器，单一持有在 `lib/webdav.js`：设置 CRUD（`backup.webdav.*` 键域，密钥加密存储）+ MKCOL/PUT/DELETE 传输（URL 逐段编码、Basic 鉴权、超时）。`backupService` 备份生命周期与传输只在 createBackup 一处交汇（失败容错不阻断本地备份）。lib→services 边（settingsService 消费）沿用 auth.js→unlockSessionService 先例。
_Avoid_: WebDAV 备份、dav 上传
