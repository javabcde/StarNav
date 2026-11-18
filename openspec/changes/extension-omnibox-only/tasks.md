## 1. 移除书签镜像（插件）

- [x] 1.1 删除 `bookmark-mirror-logic.js`；`background.js` 的 `importScripts` 去掉该文件，删除镜像常量/串行链/`mirrorEnabled`/`ensureMirrorFolderId`/`applyBookmarkMirror`/`syncBookmarkMirror`/`removeBookmarkMirror`
- [x] 1.2 `background.js` 新增 `purgeLegacyBookmarkMirror()`：读 `bookmark:mirror:folderId` → `removeTree`（吞错）→ 清键；挂到 `onInstalled` 与 `onStartup`
- [x] 1.3 `chrome.storage.onChanged` 删除 `mirrorBookmarks` 与全量缓存变更的镜像对齐分支（仅保留站点名→右键菜单标题）
- [x] 1.4 `extension-contract.js`：删除 `STORAGE_KEYS.BOOKMARK_MIRROR_FOLDER_ID` 与 `CONFIG_KEYS.sync` 的 `mirrorBookmarks`
- [x] 1.5 `options.html`/`options.js`：删除镜像开关、读取/保存/测试连接的 `mirrorBookmarks`、清空配置前的 `removeTree`
- [x] 1.6 `sync-view.js`：`flattenBookmarks` 去掉 `excludeFolderId`，`syncBookmarks` 不再查镜像 id

## 2. 地址栏关键字 `sn` → `q`

- [x] 2.1 `manifest.json`：`omnibox.keyword = "q"`，版本 `1.2.0 → 1.3.0`
- [x] 2.2 `background.js` omnibox 段注释、`README.md`、`CONTEXT.md` 的 `sn` 全部改 `q`

## 3. 测试与回归

- [x] 3.1 删除 `tests/bookmark-mirror-logic.test.js`、`tests/bookmark-mirror-background.test.js`
- [x] 3.2 `tests/extension-contract.test.js` 去掉镜像键/配置断言；`tests/options-config-persist.test.js` 删除镜像持久化用例
- [x] 3.3 `tests/popup-view-mount.test.js`：镜像排除用例改为「根文件夹不进 folderPath，自定义文件夹嵌套拼接」
- [x] 3.4 新增 `tests/extension-omnibox-only.test.js`：manifest 关键字 `q` + `bookmarks` 权限保留；`onStartup` 清理旧镜像 id（重复启动不重复删除）；有全量缓存时不创建任何浏览器书签
- [x] 3.5 `npm run quality`（syntax check + 全量 node:test）通过

## 4. 产出物同步

- [x] 4.1 `README.md` 地址栏搜索章节改为单一路径（`q` + 空格），删除镜像说明
- [x] 4.2 `CONTEXT.md`：`地址栏搜索` 条目改为单一路径 + `q`；删除 `书签镜像 (Bookmark Mirror)` 词条，`书签镜像` 进 Avoid 列表
- [x] 4.3 `openspec/changes/extension-bookmark-mirror` 与 `extension-omnibox-search` 归档；本变更记录 MODIFIED/REMOVED 要求
- [x] 4.4 实测路径记录：`chrome://extensions` 重载插件（1.3.0）→ 「其他书签/StarNav 收藏」被自动删除 → 地址栏输入 `q` + 空格 → 出现 StarNav 搜索提示条，输入关键词出候选 → 回车打开原始 URL
