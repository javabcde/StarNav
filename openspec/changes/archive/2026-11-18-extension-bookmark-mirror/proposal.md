## Why

用户希望地址栏输入关键词就直接出现自己的 StarNav 收藏，**不输入任何前缀**。Chrome 扩展的 `chrome.omnibox` 必须先在 manifest 注册关键字（`sn`），扩展无法向默认地址栏注入建议，也无法把关键字设为空。零前缀的唯一浏览器原生通道是 Chrome 自带的**书签联想**：浏览器会为所有书签（含扩展通过 `chrome.bookmarks` 写入的条目）提供地址栏候选。

## What Changes

- 新增 `bookmark-mirror-logic.js`（UMD 纯逻辑）：可镜像字段判定（非私人 http(s)）、目标列表去重、现有书签与目标的增量计划（create/update/remove）、「其他书签」根节点定位。
- 新增「书签镜像」：background 把全量缓存中的**非私人**收藏投影到浏览器「其他书签/StarNav 收藏」文件夹，Chrome 地址栏原生联想即可命中，无需 `sn`。
- 镜像触发：全量缓存变化（`chrome.storage.onChanged` local）、扩展安装/浏览器启动、开关变更。串行队列 + 小并发创建；缓存缺失时不操作。
- 增量对齐：按 URL 配对，标题变化更新、URL 消失删除、新 URL 创建；用户自建子文件夹不删除。
- `extension-contract.js`：新增 `STORAGE_KEYS.BOOKMARK_MIRROR_FOLDER_ID`、配置键 `mirrorBookmarks`。
- `options.html` / `options.js`：新增「地址栏直接联想 StarNav 收藏（无需关键字）」开关（默认开启）；关闭时删除镜像文件夹。
- `sync-view.js`：一键同步的浏览器书签快照按镜像文件夹 id 排除，避免镜像反向回流 StarNav。
- `manifest.json` 版本 1.1.0 → 1.2.0；不新增权限（`bookmarks` 已在申请清单中）。

## Capabilities

### New Capabilities

- `extension-bookmark-mirror`: StarNav 收藏到浏览器书签的只读镜像与地址栏原生联想。

### Modified Capabilities

- `extension-browse`：无行为变更；镜像与一键同步共享全量缓存，但同步快照新增排除镜像文件夹（属于 `书签同步` 既有语义的防回流修正）。
