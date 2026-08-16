# 搜索评分纯管线独立为叶模块：searchScoring.js

2026-08-16 架构评审（improve-codebase-architecture）候选 1 实施收口。评审重开了 siteService.js 头注释的
已记录决策（「搜索/评分与 analytics 簇留在本文件，接缝不成立」）——该裁定论证的是**整簇搬迁**
（searchSites/getSiteAnalytics 与列表查询共享 SITE_SELECT_COLUMNS/applyVisibilityWhere/toSafeLikePattern/
attachTagsToSites 等私有查询基建，整簇搬迁需导出基建或复制共享逻辑），但**纯评分管线不触碰任何查询基建**，
决策比真实接缝粗；且 ~225 行精细策略（权重、匹配理由词汇、拼音首字母推断、24 词上限）此前只能经
mock D1 的 searchSites 间接触达，CJK 首字母路径（'xktc' → 星空图床）零直接测试。

Status: accepted

## 决策要点

- **新建 `services/searchScoring.js`（搜索评分，零 D1 叶模块）**：收编 parseSearchQuery（筛选语法 +
  CJK 2/3/4 元组 ngram 扩展）、matchesAdvancedFilters（高级筛选谓词）、scoreSite（评分管线）及
  其私有依赖（CJK_INITIALS / PINYIN_INITIAL_BOUNDARIES / getCjkInitials / getCjkNgrams / getHostParts /
  inferPinyinInitial / normalizeSearchText）。依赖仅 lib/utils（cleanText）、accessService（normalizeVisibility）、
  healthQuery（isDeadSite/isOkSite）——与 submissionAnalytics / healthQuery / aiLocalLogic 纯逻辑叶同构。
- **siteService 保留**：toSafeLikePattern（与 getSites 共享，属查询编排面）、查询编排（searchSites 主查询 +
  两层回退梯 + attachTags）、analytics 读簇（getSiteAnalytics/getSearchAnalytics）、recordSearchTerm。
  searchSites 只消费叶模块导出；输出形状 `_score/_matchedFields/_matchReasons` 是跨模块契约
  （aiService.searchExpandedSites 亦消费 _score 重排），叶模块不持有 D1 面。
- **行为矩阵直测** `tests/searchScoring.test.js`：权重等级语义（完全匹配 1000 > 包含 520 > 首字母 420）、
  CJK 首字母路径、筛选谓词、ngram 展开、matchReasons 去重/截断——此后改权重/理由词汇必须同步矩阵。
- 头注释同步改写：原「接缝不成立」裁定保留其成立范围（整簇搬迁），并标注纯管线已迁出。

## Consequences

- **行为不变**：函数体逐字搬迁（含 scoreSite 的 hits 对数加成与 14 天时间衰减）；siteService 存量测试
  经 searchSites 接口零改动通过（24/24 同文件回归）。
- **locality**：评分策略 bug 集中在单模块，可脱离 D1 直测；siteService 从 1108 行降至 ~880 行。
- **后续**：搜索权重调优、新增筛选语法（如 is: 扩展）的改动面收敛为一个文件 + 一个测试文件。
