## Why

1.2.0 为换取「地址栏零前缀联想」，把非私人收藏镜像到浏览器「其他书签/StarNav 收藏」文件夹。该方案让站内收藏冒充浏览器书签：用户在书签管理器/书签栏看到一份只读副本，容易被误认为自己的浏览器书签；同时带来镜像对齐、反向回流排除、开关删除等一整套维护面，收益仅是省掉一个关键字前缀。

明确取舍：不接受「伪装成浏览器书签栏」的方案，只保留 `q` + 空格的 StarNav 专属地址栏搜索。插件不再向浏览器书签写入任何 StarNav 收藏。

Chrome 官方要求扩展 omnibox 必须声明 `omnibox.keyword`，扩展无法向默认地址栏注入建议——「无前缀 + 原生联想」在 API 层面不存在。零前缀需求改由弹窗搜索承接：`Ctrl+Shift+F` 打开即聚焦搜索框，输入后回车直开首条。

## What Changes

- **移除书签镜像（BREAKING）**：删除 `bookmark-mirror-logic.js`、background 的镜像对齐/开关监听、「其他书签/StarNav 收藏」文件夹管理；插件不再创建、更新、删除该镜像文件夹。
- **升级清理**：1.2.x 记录的 `bookmark:mirror:folderId` 在 `onInstalled`/`onStartup` 时一次性删除残留镜像文件夹并清除该键（只按旧版本自己记录的 id 删除，不触碰用户同名文件夹）。
- **omnibox 关键字 `sn` → `q`**：地址栏输入 `q` + 空格（或 Tab）进入 StarNav 收藏搜索；匹配/排序/回车语义不变。
- **一键同步简化**：`flattenBookmarks` 不再接收镜像排除 id，浏览器书签快照全量进入 `/api/sync/bookmarks`。
- **配置面收敛**：`CONFIG_KEYS.sync` 去掉 `mirrorBookmarks`，`STORAGE_KEYS` 去掉 `BOOKMARK_MIRROR_FOLDER_ID`；options 页删除「地址栏直接联想 StarNav 收藏（无需关键字）」开关及其说明。
- **权限不变**：`bookmarks` 权限保留——「一键同步」读取浏览器收藏夹仍需要它。
- **弹窗搜索直开**：打开弹窗时聚焦并全选浏览视图搜索框；搜索框内 Enter 先同步应用当前关键词（跳过 300ms 防抖），再打开列表第一条匹配；空输入不触发跳转。
- 插件版本 1.2.0 → 1.3.1；README / CONTEXT.md 同步。

## Capabilities

### New Capabilities

- `extension-browse`：弹窗搜索直开——打开即聚焦搜索框，Enter 先 flush 关键词再打开首条匹配。

### Modified Capabilities

- `extension-omnibox`：地址栏关键字由 `sn` 改为 `q`；地址栏搜索成为唯一入口。

### Removed Capabilities

- `extension-bookmark-mirror`：书签镜像、增量对齐、开关与移除、同步防回流四项要求全部移除（升级时清理旧镜像）。
