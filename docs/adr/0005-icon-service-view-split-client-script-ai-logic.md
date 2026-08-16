# 图标补全模块化、popup 视图拆分、首页脚本与 AI 纯逻辑抽取

批1（ADR-0004）收编路由与记录后，剩余摩擦集中在三处：图标自动补全概念横跨 worker/扩展两个 seam 且 28s 超时靠注释同步；popup.js（994 行、40 次提交的最热文件）三视图混装且契约被旁路；首页 ~470 行内联客户端脚本与 aiService（1122 行、三租户）无测试面。本批按"模块化 + 补 seam + 补测试面"收口。

Status: accepted

## 决策要点

- **图标自动补全（Icon Auto-Fill）模块化**：新增 `src/services/iconService.js` 收编抓取策略、KV 永久失败标记、批量刷新（自 siteService 迁出，含变更记录）；`lib/favicon.js` 保持纯抓取。`extension-contract.js` 新增 `ICON_TIMEOUT_MS`（28s，注释持有 5 源 × 5s 预算与 Workers 30s 上限）、`ICON_FAILURE_REASONS`（与服务端 reason 逐字对齐）、`ICON_DEBUG_TTL_MS`；background 与 popup 消费常量，不再手写魔数。
- **popup 三视图拆分**：popup.js 收缩为壳（元素注册表、配置、三 Tab 状态机、视图装配）；`browse-view.js` / `collect-view.js` / `sync-view.js` 为 UMD 视图模块，`create(ctx)` 工厂 + `mount/onEnter/onLeave` 生命周期 seam；视图经 ctx 取共享依赖（els/apiFetch/setStatus/Contract/BrowseLogic），收藏/同步的缓存刷新经 `onCacheMutated` 钩子指向浏览视图。删除源码正则锁测试（popup-view-persist.test.js），以 stub DOM 冒烟测试替代（tests/popup-view-mount.test.js）。
- **首页客户端脚本模块化**：~470 行内联脚本抽为 `src/pages/home/clientScript.js`——`homeClientScript({...})` 函数经 `String.raw` 保真输出（正文含 `\n`/`\u` 转义与 7 处服务端插值：accent/layout/bg/i18n/scripts 模块调用）；renderHomePage 从 924 行降至 ~450 行，补首个渲染冒烟测试（tests/homeRender.test.js）。沿用既有 `home/scripts.js` 模式。
- **aiService 纯逻辑与模型管道抽取**：`src/services/aiLocalLogic.js` 收编 21 个纯函数（意图识别、关键词推断、本地标签/分类/合并回退），`src/services/aiModelService.js` 收编 `DEFAULT_AI_SETTINGS`/`normalizeAiSettingsPayload`/`getModelsEndpoint`/`callOpenAiCompatible`；aiService 保留 env 耦合的编排（searchExpandedSites/resolveContextSites/chat/suggest/analytics 租户）。租户文件拆分后移（Speculative 未做）。

## Consequences

- 图标超时与失败原因单一来源：改服务端预算只动契约一处；popup 调试展示与 background 记录共用同一 reason 语义。
- 视图层首次获得运行时 seam：mount/onEnter/onLeave 可在 stub DOM 下直接测试，正则锁删除；行为面（saveBookmark 提交 + 缓存刷新钩子）经视图接口验证。
- 首页脚本可独立于渲染函数修改与测试；插值面收敛为函数参数，服务端渲染与客户端脚本解耦。
- AI 纯逻辑与模型调用成为独立测试面（意图六分类、查询扩展、本地回退、端点推导、响应解析均有断言），chat 行为回归由 read-access-filter.test.js 保持。
- 行为保持：三视图为逐字迁移（监听/状态/时序不变）；aiService 导出面不变；首页渲染输出经 String.raw 与迁移前逐字节等价（插值参数同名传入）。
- 未覆盖：`options.js` 的 CONFIG_KEYS 旁路（契约已存在但消费方未接入，属后续）；popup 壳本身（tab 切换）仍无自动化测试。
