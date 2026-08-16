## Why

1. **renderHomePage 单函数 924 行**：查询参数解析、布局片段分发、HTML 壳、~470 行内联客户端脚本混装；片段渲染器（renderSiteCard/renderGroupedSites…）已在 `pages/home/*` 模块化，壳本身没跟上；内联脚本含 7 处服务端插值与 `\n`/`\u` 转义，无独立测试面（仓库对 renderHomePage 零测试）。
2. **aiService 1122 行三租户**：chat（本地意图 NLU）、suggest（标签/分类建议）、analytics（管理分析）混装；21 个纯函数（意图识别、关键词推断、本地回退）埋在服务里无法直接测试——AGENTS.md 覆盖缺口表点名 aiService；仅 chat 路径经 read-access-filter.test.js 间接覆盖。

## What Changes

- **首页客户端脚本模块化**：~470 行内联脚本抽为 `src/pages/home/clientScript.js`——`homeClientScript({ defaultAccent, pageBackgroundImage, defaultLayout, i18n, myUsageScript, frontAdminScript, dragScript, adminAuthed, canDragSort })` 经 `String.raw` 模板保真输出（正文含 `\n`/`\u23f3` 等转义与 7 处插值）；renderHomePage 924 行 → ~450 行，仅留状态计算与片段编排。沿用既有 `home/scripts.js` 模式。
- **aiService 拆纯逻辑与模型管道**：`src/services/aiLocalLogic.js` 收编 21 个纯函数（无 env 依赖：detectBookmarkIntent/inferSearchKeywords/filterSitesByContainsKeyword/buildLocalAnswer/suggestTagsLocally/suggestCategoryLocally/suggestTagMergesLocally/parseSuggestedTags…）；`src/services/aiModelService.js` 收编 `DEFAULT_AI_SETTINGS`/`normalizeAiSettingsPayload`/`getModelsEndpoint`/`callOpenAiCompatible`；aiService 保留 env 耦合编排（searchExpandedSites/resolveContextSites/chat/suggest/analytics 租户）。租户文件拆分后移（Speculative 未做）。
- **测试面**：新增 tests/homeRender.test.js（首个首页渲染冒烟：clientScript 输出与插值断言）、tests/aiLocalLogic.test.js（8 项）、tests/aiModelService.test.js（5 项）。
- ADR 0005 记录决策。

## Capabilities

### New Capabilities

无（行为不变的重构，`.openspec.yaml` 已设 `skip_specs: true`）。

### Modified Capabilities

无（clientScript 输出与迁移前逐字节等价——String.raw 保真 + 插值参数同名透传；aiService 导出面不变）。
