## 1. 后端：Token 私人可见性

- [x] 1.1 `src/handlers/api.js` 封装 helper（如 `getReadAccess(request, env)` 返回 {adminAuthed, privateAccess}）：`privateAccess = adminAuthed || 有效 token（validateApiToken(request, env, '')） || hasPrivateBookmarkAccess`
- [x] 1.2 三处接入：`/search`、`/ai/chat`、`isSitesCollectionPath GET`（替换现有 `adminAuthed || hasPrivateBookmarkAccess` 计算）；scope 不足 `forbidden` 语义保留

## 2. 插件：Tab 布局

- [x] 2.1 `popup.html` 改三 tab 结构（浏览/收藏/同步），现有收藏表单与同步区平移为 tab 内容；tab 激活样式
- [x] 2.2 `popup.js` tab 切换逻辑（显示/隐藏 + 激活态）；「浏览」为默认视图

## 3. 插件：浏览视图

- [x] 3.1 打开弹窗并行拉 `GET /api/config?page=1&pageSize=30&sort=` + `GET /api/categories`，渲染列表与分类胶囊
- [x] 3.2 搜索框防抖 300ms → `keyword` 参数与当前分类/排序组合请求；清空恢复
- [x] 3.3 分类胶囊横滚（含私人书签）；「全部」默认；切换分类重置分页
- [x] 3.4 排序切换：站点序（默认）/ hits / last_visit / name
- [x] 3.5 「加载更多」（pageSize 30，按 total 判终止）；手动刷新按钮
- [x] 3.6 列表项：logo（缺失 → 首字母占位）+ 标题 + 域名；点击 `chrome.tabs.create({url, active:true})` + 关闭弹窗
- [x] 3.7 状态：加载骨架 / 空态 / 错误（401 引导重配 token，其余透出 message）

## 4. 验证与文档

- [x] 4.1 后端测试：`tests/bookmarkSync.test.js` 旁新增或扩展——token 私人可见性（mock validateApiToken 路径在 handler 层验证成本高，改为对 helper 逻辑断言 + 手工 harness 验证三处接入）
- [x] 4.2 `node --check` popup.js / check-syntax 全绿；`node --test` 全绿
- [x] 4.3 `docs/api-guide.md`：token 私人书签读取语义（ADR-0002 引用）；README 插件能力列表补「站内书签浏览」
