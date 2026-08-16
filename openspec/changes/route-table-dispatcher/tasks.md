## 1. 路由表收编

- [x] 1.1 `handlers/api/resources/` 八个资源模块（sites/categories/tags/backups/settings/analytics/admin/ai），端点命名处理函数，签名 `(request, env, ctx, path, method, id, url)`，未命中返回 null
- [x] 1.2 api.js 重写为表驱动 dispatcher（exact/anyMethodOn/regex 匹配器 + ROUTES 表 + 404 兜底 + handleApiError），848 行 → ~140 行
- [x] 1.3 `errors.js:requireSubmitter` 收编 `/site/preview` 与 `/submit/suggest-*` 三段鉴权（原 api.js:287-294/306-312/319-325 逐字复制）
- [x] 1.4 门禁保真：tokens/:id 仅 DELETE 进门禁；/categories 集合未知方法 404 不进门禁；/webhooks/:id 与 /backups/:id 任意方法先进门禁
- [x] 1.5 死代码清理：`getSiteRouteFlags`（api/sites.js）删除；序列化函数 sitesToCsv/sitesToBookmarkHtml 保留

## 2. 可见性 SQL 单一渲染

- [x] 2.1 `accessService.visibilityWhere(access)` 返回 `{ sql, binds }`（admin 空谓词 / 解锁 IN / 匿名 =public+排除私密分类）
- [x] 2.2 siteService 六处复制（getSites/getAllSites/searchSites×2/listSitesByIds/搜索回退）替换为 `applyVisibilityWhere`；`filters.visibility` 与无 join 遗留回退不动
- [x] 2.3 测试：accessService.test.js 新增 visibilityWhere 四态断言（admin/解锁/匿名/缺省 null 按匿名）

## 3. 变更记录服务化

- [x] 3.1 `logOperation` 新增 `ip` 字段（request 兼容保留），`clientIpFromRequest` 导出
- [x] 3.2 siteService 十二处写函数（create/update/delete/bulk×4/reorder/import/approve/reject/bulkCheck/bulkFavicon）服务内落库
- [x] 3.3 categoryService（create/update/delete/reorder）、tagService（merge/applySuggestions）、backupService（create/delete/restore）落库；restore 的 pre-restore 快照一并记录
- [x] 3.4 bookmarkSyncService：syncBookmarks 汇总记录入服务（非 dryRun）、unsyncSite 记录（changed/已手动两态）
- [x] 3.5 api.js 全部 22 处 `safeLog(logOperation(...))` 删除；safeLog 助手保留（search 词记录仍用）
- [x] 3.6 测试：tests/mutationRecording.test.js 七项（SITE_CREATE/UPDATE/DELETE、CATEGORY_CREATE/DELETE、BACKUP_DELETE、UNSYNC 含 ip 透传与绑定顺序断言）

## 4. 收尾

- [x] 4.1 ADR 0004（路由表 dispatcher + 变更记录服务化 + 可见性 SQL 单一渲染）
- [x] 4.2 `npm run quality` 全绿（225/225，含 apiRouter 11 项 + mutationRecording 7 项）
- [ ] 4.3 中文提交（git）
