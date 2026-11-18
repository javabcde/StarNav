## Why

1.2.0 为换取「地址栏零前缀联想」，把非私人收藏镜像到浏览器「其他书签/StarNav 收藏」文件夹。该方案让站内收藏冒充浏览器书签：用户在书签管理器/书签栏看到一份只读副本，容易被误认为自己的浏览器书签；同时带来镜像对齐、反向回流排除、开关删除等一整套维护面，收益仅是省掉一个关键字前缀。

明确取舍：不接受「伪装成浏览器书签栏」的方案，只保留 `q` + 空格的 StarNav 专属地址栏搜索。插件不再向浏览器书签写入任何 StarNav 收藏。

实测补充：Brave 1.98（Chromium 156）的地址栏只派发 `onInputEntered`，不派发 `onInputStarted`/`onInputChanged`（最小探针扩展同样复现），地址栏候选在 Brave 不可用。按用户决定**不再提供弹窗搜索替代**，`q` + 空格保留给 Chrome/Edge 等会派发扩展 omnibox 输入事件的浏览器。

## What Changes

- **移除书签镜像（BREAKING）**：删除 `bookmark-mirror-logic.js`、background 的镜像对齐/开关监听、「其他书签/StarNav 收藏」文件夹管理；插件不再创建、更新、删除该镜像文件夹。
- **升级清理**：1.2.x 记录的 `bookmark:mirror:folderId` 在 `onInstalled`/`onStartup` 时一次性删除残留镜像文件夹并清除该键（只按旧版本自己记录的 id 删除，不触碰用户同名文件夹）。
- **omnibox 关键字 `sn` → `q`**：地址栏输入 `q` + 空格（或 Tab）进入 StarNav 收藏搜索；匹配/排序/回车语义不变。Brave 实测不可用（见上），不改关键字做规避。
- **建议同步交付**：background 维护全量缓存内存快照，`onInputChanged` 在同一回调内同步交付默认行与候选；冷启动先同步给「正在加载」+ 空建议，再异步补齐。
- **一键同步简化**：`flattenBookmarks` 不再接收镜像排除 id，浏览器书签快照全量进入 `/api/sync/bookmarks`。
- **配置面收敛**：`CONFIG_KEYS.sync` 去掉 `mirrorBookmarks`，`STORAGE_KEYS` 去掉 `BOOKMARK_MIRROR_FOLDER_ID`；options 页删除「地址栏直接联想 StarNav 收藏（无需关键字）」开关及其说明。
- **权限不变**：`bookmarks` 权限保留——「一键同步」读取浏览器收藏夹仍需要它。
- 插件版本 1.2.0 → 1.3.5；README / CONTEXT.md 同步（含 Brave 限制说明）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `extension-omnibox`：地址栏关键字由 `sn` 改为 `q`；仍是唯一地址栏入口。

### Removed Capabilities

- `extension-bookmark-mirror`：书签镜像、增量对齐、开关与移除、同步防回流四项要求全部移除（升级时清理旧镜像）。
