## 1. 移除书签镜像（插件）

- [x] 1.1 删除 `bookmark-mirror-logic.js`；`background.js` 的 `importScripts` 去掉该文件，删除镜像常量/串行链/`mirrorEnabled`/`ensureMirrorFolderId`/`applyBookmarkMirror`/`syncBookmarkMirror`/`removeBookmarkMirror`
- [x] 1.2 `background.js` 新增 `purgeLegacyBookmarkMirror()`：读 `bookmark:mirror:folderId` → `removeTree`（吞错）→ 清键；挂到 `onInstalled` 与 `onStartup`
- [x] 1.3 `chrome.storage.onChanged` 删除 `mirrorBookmarks` 与全量缓存变更的镜像对齐分支（仅保留站点名→右键菜单标题、缓存快照同步）
- [x] 1.4 `extension-contract.js`：删除 `STORAGE_KEYS.BOOKMARK_MIRROR_FOLDER_ID` 与 `CONFIG_KEYS.sync` 的 `mirrorBookmarks`
- [x] 1.5 `options.html`/`options.js`：删除镜像开关、读取/保存/测试连接的 `mirrorBookmarks`、清空配置前的 `removeTree`
- [x] 1.6 `sync-view.js`：`flattenBookmarks` 去掉 `excludeFolderId`，`syncBookmarks` 不再查镜像 id

## 2. 地址栏关键字 `sn` → `q`

- [x] 2.1 `manifest.json`：`omnibox.keyword = "q"`，版本 `1.2.0 → 1.3.5`
- [x] 2.2 `background.js` omnibox 段注释、`README.md`、`CONTEXT.md` 的 `sn` 全部改 `q`

## 3. 地址栏建议交付

- [x] 3.1 内存快照：`readBrowseCache` / `refreshBrowseCache` / `storage.onChanged` 三处维护 `browseCacheSnapshot`
- [x] 3.2 `onInputChanged` 快照就绪时同步交付 `setDefaultSuggestion` + `suggest`；冷启动先同步空建议再异步补齐
- [x] 3.3 `onInputStarted` 立即设置默认行（加载中/总条数），作为关键字模式是否接管的可见信号
- [x] 3.4 测试：`tests/extension-omnibox-only.test.js` 覆盖「有快照时同一回调交付候选」「冷启动先同步空建议再异步补齐」

## 4. 弹窗搜索（实现后按用户要求移除）

- [x] 4.1 曾实现：打开弹窗聚焦并全选搜索框、搜索框 Enter 先 flush 关键词再打开首条（提交 f881a09）
- [x] 4.2 Brave 实测确认地址栏不派发扩展输入事件后重新引入（提交 0dad4b4）
- [x] 4.3 用户明确不要该功能：移除 `applyBrowseKeyword`/`openFirstBrowseMatch`/Enter 监听、popup 聚焦、相关测试与文档，浏览视图恢复原行为（1.3.5）

## 5. 测试与回归

- [x] 5.1 删除 `tests/bookmark-mirror-logic.test.js`、`tests/bookmark-mirror-background.test.js`
- [x] 5.2 `tests/extension-contract.test.js` 去掉镜像键/配置断言；`tests/options-config-persist.test.js` 删除镜像持久化用例
- [x] 5.3 `tests/popup-view-mount.test.js`：镜像排除用例改为「根文件夹不进 folderPath，自定义文件夹嵌套拼接」
- [x] 5.4 新增 `tests/extension-omnibox-only.test.js`：manifest 关键字 `q` + `bookmarks` 权限保留；`onStartup` 清理旧镜像 id（重复启动不重复删除）；有全量缓存时不创建任何浏览器书签
- [x] 5.5 `npm run quality`（syntax check + 全量 node:test）通过

## 6. 产出物同步

- [x] 6.1 `README.md`：地址栏搜索章节 + Brave（Chromium 156）实测限制说明
- [x] 6.2 `CONTEXT.md`：`地址栏搜索` 条目改为单一路径 + `q`，注明 Brave 限制；删除 `书签镜像 (Bookmark Mirror)` 词条，`书签镜像` 进 Avoid 列表
- [x] 6.3 `openspec/changes/extension-bookmark-mirror` 与 `extension-omnibox-search` 归档；本变更记录 MODIFIED/REMOVED 要求
- [x] 6.4 实测记录：`chrome://extensions` 重载插件 → 「其他书签/StarNav 收藏」被自动删除 → Brave 下 `q` + 空格无候选（最小探针复现，Brave 限制）；Chrome/Edge 预期正常，未在本机验证
