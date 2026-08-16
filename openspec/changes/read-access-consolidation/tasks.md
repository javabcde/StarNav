## 1. 读接口收口

- [x] 1.1 `getSites` / `searchSites` / `listSitesByIds`：`access` 优先于遗留布尔（`resolvedAccess = access || { adminAuthed, privateUnlocked }` 语义与默认值保持现状，存量测试零改动——ADR 0003 已落地，无代码改动）
- [x] 1.2 `getAllSites(env, { space, space_id, access })`：access 存在时应用与 getSites 相同的可见性 SQL 片段（主查询 + 降级查询的私密分类守卫）；实现期曾误删 `whereSql` 行致主查询崩溃，已恢复并经等价性测试守护
- [x] 1.3 `getSiteAnalytics(env, { limit, access })`：追加与 searchSites 完全相同的可见性 SQL 片段（topByHits / recentlyActive / inactiveSites 三查询统一；categoryHeat/totals 为聚合统计不涉站点行）
- [x] 1.4 aiService `chatWithAiAssistant` 排行意图透传 `access`；并修复存量字段名 bug `analytics.topHits` → `topByHits`（排行分支此前恒空、静默落回搜索——泄露原仅为接口级隐患，修复后过滤真实生效）

## 2. 调用面迁移

- [x] 2.1 home.js：`getAllSites(env, { access: { adminAuthed: access.adminAuthed, privateUnlocked: access.browserPrivateUnlocked } })`，删除 `sites.filter(access.canList)`；子孙/标签/排序呈现过滤保留
- [x] 2.2 exportConfig（siteService.js:1992）传 `{ adminAuthed: true }`
- [x] 2.3 api.js:598 `/api/analytics/sites` 传 `{ adminAuthed: true }`（默认匿名过滤下不丢 admin 数据）；getAllSites / getSiteAnalytics 调用面已 grep 确认全部显式传 access
## 3. 测试

- [x] 3.1 存量测试零改动（遗留布尔兼容保留，原样通过）
- [x] 3.2 新增 getSiteAnalytics 三态过滤测试（tests/read-access-filter.test.js）
- [x] 3.3 新增 chat 排行泄露回归测试（匿名 id 集合 [1] / 解锁 [1,2,5]——analytics 映射层不携带 visibility，按 id 断言）
- [x] 3.4 home 可见性等价性：getAllSites SQL 过滤与 canListSite 谓词三态一致（匿名/解锁/管理员）

## 4. 收尾

- [x] 4.1 ADR 0003 追加「后续（2026-08-16）」备注：布尔按兼容保留（非删除）、getAllSites/getSiteAnalytics 收编、topHits 字段名修复
- [x] 4.2 `npm run quality` 全绿（172/172：新增 6 项 read-access 测试，旧测试零改动）
- [ ] 4.3 中文提交（git）
