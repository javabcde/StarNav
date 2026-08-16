## 1. 首页客户端脚本模块化

- [x] 1.1 抽取 448-920 行内联脚本为 `src/pages/home/clientScript.js`：`homeClientScript({...})` 函数 + String.raw 保真（正文 0 反引号、`${` 恰 7 处插值的前提经脚本内断言）
- [x] 1.2 插值面收敛：defaultAccent/pageBackgroundImage/defaultLayout/i18n/scripts 模块调用/adminAuthed/canDragSort 同名作参数；escapeHTML 模块内 import（相对路径 ../../lib/utils.js）
- [x] 1.3 home.js 以一行调用替换 473 行内联脚本（924 → ~450 行）；import 接入
- [x] 1.4 新增 tests/homeRender.test.js（首个首页渲染冒烟：clientScript 标记 + 插值断言）

## 2. aiService 纯逻辑与模型管道抽取

- [x] 2.1 `src/services/aiLocalLogic.js`：21 个纯函数 + QUERY_EXPANSIONS 迁入并 export（意图/关键词/包含过滤/本地回退/标签分类合并建议/解析器）
- [x] 2.2 `src/services/aiModelService.js`：DEFAULT_AI_SETTINGS / normalizeAiSettingsPayload / getModelsEndpoint / callOpenAiCompatible 迁入（import stripMarkdownArtifacts）
- [x] 2.3 aiService 按需 import、切除 25 段（1122 → ~600 行）；残留引用逐名 grep 确认零遗漏；空白行清理
- [x] 2.4 新增 tests/aiLocalLogic.test.js（8 项）与 tests/aiModelService.test.js（5 项）

## 3. 收尾

- [x] 3.1 chat 全路径回归（read-access-filter.test.js / apiErrors.test.js）通过
- [x] 3.2 `npm run quality` 全绿（225/225）
- [x] 3.3 ADR 0005 记录决策（批2/3 合并记录）
- [ ] 3.4 中文提交（git）
