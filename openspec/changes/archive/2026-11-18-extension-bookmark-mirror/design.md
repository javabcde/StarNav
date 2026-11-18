## Context

- 扩展 omnibox（`extension-omnibox-search` 变更）已提供 `sn` + 空格的关键字搜索，但 Chrome 要求关键字非空，无法零前缀注入默认地址栏。
- 全量缓存 `browse:cache:v1` 存在 `chrome.storage.local`，包含当前 token 可见的全部书签；`chrome.bookmarks` 是浏览器原生书签联想的数据源，扩展有 `bookmarks` 权限。
- 一键同步（`sync-view.js`）以浏览器书签为事实源，把快照 POST 到 `/api/sync/bookmarks`；如果镜像文件夹进入快照，会被当成浏览器书签回写 StarNav，形成回流。

## Goals / Non-Goals

**Goals:**

- 地址栏输入标题/URL 关键词时，StarNav 收藏出现在 Chrome 原生联想中，无需 `sn` 或任何前缀。
- 镜像自动跟随全量缓存变化（新增、改名、删除）。
- 私人/管理员专属书签不写入浏览器书签。
- 一键同步不回写镜像内容。
- 用户可关闭镜像；关闭时删除插件管理的文件夹。

**Non-Goals:**

- 不改变 Chrome 默认搜索引擎，不影响普通网页搜索。
- 不做双向同步：镜像只读，手动编辑会被下次对齐覆盖。
- 不镜像分类/标签/描述（Chrome 书签只有标题和 URL）。
- 不保证 Chrome 联想只显示 StarNav 收藏——浏览器仍会混排历史、其他书签与搜索建议（扩展无权过滤默认地址栏）。

## Decisions

1. **选择「其他书签/StarNav 收藏」文件夹作为投影面**。
  Chrome 原生书签联想覆盖所有文件夹；放在「其他书签」避免占用书签栏。文件夹由插件独占管理，id 存 `bookmark:mirror:folderId`；首次创建不按标题复用已有文件夹，避免把用户同名文件夹当镜像接管并删除其中书签。备选：直接写「其他书签」根节点——污染用户根目录且难以整体撤销，拒绝。

2. **纯逻辑模块 `bookmark-mirror-logic.js`**。
   可镜像判定、目标去重、增量计划、根节点定位都可在 node:test 直接覆盖；background 只做 chrome API 执行。沿用 `popup-logic.js` / `omnibox-logic.js` 的 UMD + vm 测试模式。

3. **镜像源与过滤**。
   只用全量缓存（`browse:cache:v1`），不额外请求；`visibility` 为 `private`/`admin_only` 或分类为「私人书签」（旧数据兜底）的条目不镜像；仅 http(s)；同 URL 去重保留第一条。理由：浏览器书签可能随 Chrome 账号同步到云端，私人数据不进入。

4. **增量对齐而非全量重建**。
   `planBookmarkMirror(existing, desired)` 按归一化 URL 配对：标题变化 → `bookmarks.update`；缓存中消失 → `bookmarks.remove`；新增 → `bookmarks.create`（并发 6）。Chrome 会把根路径存成 `https://host/`，配对键只在根路径去掉尾斜杠（带路径/query/hash 原样），否则每次镜像都会把同一 URL 当成删除+新建。文件夹节点（无 url）不参与删除，保留用户自建的子文件夹。全量重建会丢失书签 id、造成 Chrome 同步风暴，拒绝。

5. **触发与串行化**。
   - `chrome.storage.onChanged`：local 的 `browse:cache:v1` 变化 → 对齐；sync 的 `mirrorBookmarks` 变化 → true 对齐 / false 或配置清空删除。
   - `onInstalled` / `onStartup`：读现存缓存对齐。
   - 所有镜像动作走 `bookmarkMirrorChain` 串行队列，避免并发创建重复文件夹或删除与创建交错。
   - 开关默认开启（`mirrorBookmarks !== false`）。

6. **同步快照排除镜像文件夹**。
   `syncBookmarks` 读取 `BOOKMARK_MIRROR_FOLDER_ID` 并传给 `flattenBookmarks`，遍历时跳过该节点及其子树。备选：按文件夹标题排除——可能误伤用户同名文件夹，拒绝。

## Risks / Trade-offs

- **浏览器书签出现可见副本**：非私人收藏会在「其他书签/StarNav 收藏」出现；关闭开关会删除该文件夹（含用户手动加入的子文件夹，开关文案已说明）。
- **Chrome 账号同步**：镜像会随浏览器书签同步到云端（仅非私人数据）。
- **手动编辑被覆盖**：镜像只读；用户改标题/URL 后下次对齐会恢复。README 已说明。
- **联想混排**：StarNav 收藏与历史/搜索建议混排，扩展无法只显示自己的收藏；这是零前缀路线的固有限制。
- **首次镜像量大**：500+ 条时小并发创建，期间可能短暂出现部分条目；失败条目下次缓存变化时自动补齐。
- **镜像文件夹被用户删除**：`ensureMirrorFolderId` 检测失效后重建；若用户想永久关闭，应使用选项开关。
