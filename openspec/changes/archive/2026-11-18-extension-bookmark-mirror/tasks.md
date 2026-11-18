## 1. 纯逻辑模块

- [x] 1.1 新建 `extensions/browser-bookmark/bookmark-mirror-logic.js`（UMD）：`isMirrorableSite`（非私人/管理员专属、仅 http(s)、私人书签分类兜底）、`desiredMirrorBookmarks`（同 URL 去重、标题回退 URL）、`planBookmarkMirror`（create/update/remove、忽略文件夹节点、清理重复 URL）、`pickOtherBookmarksRootId`（中英文标题 + id '2' 兜底）
- [x] 1.2 `tests/bookmark-mirror-logic.test.js`：过滤矩阵、去重、增量计划、根节点定位（5 条）

## 2. 契约与 background

- [x] 2.1 `extension-contract.js`：`STORAGE_KEYS.BOOKMARK_MIRROR_FOLDER_ID = 'bookmark:mirror:folderId'`；`CONFIG_KEYS.sync` 增加 `mirrorBookmarks`
- [x] 2.2 `background.js` `importScripts` 追加 `bookmark-mirror-logic.js`；实现 `ensureMirrorFolderId` / `applyBookmarkMirror` / `syncBookmarkMirror` / `removeBookmarkMirror`（串行队列、创建并发 6、单条失败不阻塞）
- [x] 2.3 触发：缓存变化（storage.onChanged local）、安装/启动、开关变化（true 对齐；false/清空删除）
- [x] 2.4 `sync-view.js`：`flattenBookmarks` 接受排除文件夹 id；`syncBookmarks` 从 storage 读取镜像 id 并排除
- [x] 2.5 `tests/popup-view-mount.test.js`：排除镜像文件夹、不传 id 时保持原行为

## 3. 选项与显示

- [x] 3.1 `options.html` 新增「地址栏直接联想 StarNav 收藏（无需关键字）」复选框 + 说明
- [x] 3.2 `options.js` 读取/保存 `mirrorBookmarks`；清空配置时复选框回默认开启
- [x] 3.3 `manifest.json` 版本 1.2.0（无新权限）

## 4. 文档

- [x] 4.1 插件 README：两种地址栏搜索方式（原生镜像 / `sn` 关键字）、私人书签排除、只读语义、`sn` 空格激活与关键字冲突排查
- [x] 4.2 `CONTEXT.md`：「地址栏搜索」词条合并两条路径（原生镜像为主、`sn` 关键字为次）；「书签镜像」词条承载只读投影/同步排除/私人不镜像三条约束

## 5. 验证

- [x] 5.1 `tests/bookmark-mirror-logic.test.js` 7/7；`tests/bookmark-mirror-background.test.js` 6/6（stale id 重建、增量 plan、URL 归一不抖动、关闭删除、onChanged 触发、同名文件夹不接管）；`tests/popup-view-mount.test.js` 8/8
- [x] 5.2 `npm run quality` 全绿（479/479）
- [x] 5.3 浏览器冒烟（CatsXP + 本地 mock StarNav）：缓存写入后「其他书签/StarNav 收藏」创建，GitHub/React 写入、私人书签排除；预置的用户 StarNav 文件夹不被接管；重启/重复 sync 书签 id 稳定（修复 Chrome 根路径尾斜杠导致的删建抖动）；改名保留 id、新增条目追加；同步快照排除镜像；关闭开关删除文件夹、重新开启重建
