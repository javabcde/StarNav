## Context

- home.js 内联脚本边界：448-920 行为两个 `<script>` 块（PWA 注册/安装提示 + DOMContentLoaded 主体）；`grep '\${'` 与反引号扫描确认仅 7 处服务端插值、0 个反引号、36 处反斜杠转义（含 `\n`、`\u23f3`、正则 `\$` 等）——普通模板字面量嵌入会破坏客户端脚本，必须 String.raw。
- 7 处插值：`escapeHTML(defaultAccent)`、`pageBackgroundImage ? 'image' : 'soft'`、`escapeHTML(defaultLayout)`、`i18n?.t?.('copy') || '复制'`、`myUsageScript()`、`adminAuthed ? frontAdminScript() : ''`、`canDragSort ? dragScript(i18n) : ''`——变量在 renderHomePage 作用域内全部已存在。
- aiService 依赖面：settings 域（AI_SETTING_PREFIX/DEFAULT_AI_SETTINGS/getAiSettings/updateAiSettings）、chat 域（NLU 纯函数 + searchExpandedSites/resolveContextSites/getSiteAnalytics）、suggest 域（suggestTagsLocally/suggestCategoryLocally/parse* + 模型调用）、analytics 域（纯 SQL）；`callOpenAiCompatible` 依赖 `stripMarkdownArtifacts`（纯函数）。
- 纯函数依赖：全部只依赖 `cleanText`（lib/utils）——独立模块零循环风险。

## Goals / Non-Goals

**Goals:**
- home.js 壳瘦身；客户端脚本独立模块可改可测，插值面收敛为函数参数。
- AI 纯逻辑与模型管道可被 node:test 直接测试；chat 行为回归由 read-access-filter.test.js 保持。
- 输出逐字节等价（String.raw + 同名参数透传），导出面不变。

**Non-Goals:**
- 不做 aiService 租户文件拆分（chat/suggest/analytics 分文件——Speculative 强度，后移）。
- 不迁移头部主题脚本（3 行、插值密集，属壳状态）。
- 不引入前端构建/静态资源面（clientScript 仍走服务端渲染管线，零部署面变化）。

## Decisions

### D1：`homeClientScript(params)` 函数 + String.raw 保真
正文逐字搬入函数体模板；String.raw 使 `\n`/`\u23f3`/正则转义保持字面量，`${...}` 插值照常求值。7 处插值变量同名作函数参数（escapeHTML 在模块内 import）。home.js 以一行调用替换原 473 行。
- 验证：模块加载后以示例参数渲染，断言插值结果、字面 `\u23f3`、themeDefaults 等标记；homeRender.test.js 冒烟整页。
- 替代：静态字符串 + 模板替换占位符——二次转义风险高；拆多段字符串——插值上下文割裂。

### D2：aiLocalLogic.js 纯函数收编，aiModelService.js 管道收编
21 个纯函数 + QUERY_EXPANSIONS 迁 aiLocalLogic（全部 `export`，原为私有）；DEFAULT_AI_SETTINGS/normalizeAiSettingsPayload/getModelsEndpoint/callOpenAiCompatible 迁 aiModelService（后者从 aiLocalLogic import stripMarkdownArtifacts）。aiService 按需 import，导出面（公开函数）不变；aiService 剩余 ~600 行（settings/chat/suggest/analytics 编排）。
- 替代：函数原地加 export 供测试——接口随实现膨胀，浅化模块；租户一次拆完——改动面大、本批收益未验证。

### D3：测试面补齐
homeRender.test.js：mock env（settings 缺省走代码默认、站点/分类/标签空）→ 断言 200、clientScript 标记（serviceWorker.register/nav:pwa-state/themeDefaults/beforeinstallprompt）、插值输出（defaultAccent='blue'）。aiLocalLogic.test.js：意图六分类、查询扩展、包含过滤、本地回退文案、标签/分类/合并建议、AI 建议白名单。aiModelService.test.js：端点映射、载荷归一化（星号占位不覆盖）、调用成功剥离星号/失败抛错。

## Risks / Trade-offs

- **转义回归**：String.raw 依赖"正文无反引号、`${` 恰为 7 处插值"前提——抽取脚本内置断言（含反引号/多余插值即失败），homeRender 冒烟兜底。
- **行为漂移**：插值参数同名透传依赖 renderHomePage 变量名不变——homeRender.test.js 断言插值结果。
- **aiService 遗漏引用**：迁移后 grep 逐名确认（stripMarkdownArtifacts/formatSiteLine/siteContainsKeyword 等 9 个名字零残留）；read-access-filter.test.js（chat 全路径）回归。
