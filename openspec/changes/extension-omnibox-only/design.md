# 设计：地址栏搜索只保留 `q` 关键字

## 背景

Chrome 扩展 omnibox 必须带关键字才能进入扩展建议模式，无法向默认地址栏注入零前缀建议。1.2.0 的绕行方案是把收藏镜像成浏览器书签，借用 Chrome 原生书签联想；代价是站内收藏在浏览器书签里出现只读副本，观感上就是「伪装成浏览器书签栏」。用户明确否决该方案。

## 决策

### D1：删除镜像，不做兼容层

整体删除 `bookmark-mirror-logic.js`、background 的镜像串行链与增量对齐、options 开关、`sync-view` 的排除参数。保留任何「镜像但默认关闭」的路径都会让 1.2.x 用户升级后仍看到残留文件夹，且代码维护面不减。

备选「默认关闭、保留开关」被拒绝：功能保留即意味着文档/测试/监听器全保留，而它正是被否决的交互形态。

### D2：升级时按旧 id 清理残留文件夹

1.2.x 把镜像文件夹 id 存在 `chrome.storage.local['bookmark:mirror:folderId']`。新版在 `onInstalled` 与 `onStartup` 调用 `purgeLegacyBookmarkMirror()`：

- 有 id → `chrome.bookmarks.removeTree(id)`（失败视为用户已手动删除），随后清除该键；
- 无 id → 什么都不做，绝不按标题扫描/删除用户文件夹（保持 1.2.0「不接管同名文件夹」的安全约束）。

只清理一次：键清除后重复启动不再触碰书签。键名以字面量留在 background（`LEGACY_MIRROR_FOLDER_KEY`），不进 `extension-contract.js`——它是单向迁移输入，不是跨文件契约。

### D3：omnibox 关键字定为 `q`

单字符、输入成本最低；`q` 未被 Chrome 保留，也不与常见搜索引擎关键字冲突。manifest 关键字是用户可见契约，README/CONTEXT 同步为 `q` + 空格/Tab。匹配、排序、缓存等待/刷新、回车语义全部复用既有 `omnibox-logic.js`，零改动。

### D4：保留 `bookmarks` 权限与一键同步

「同步」视图仍用 `chrome.bookmarks.getTree()` 读取浏览器收藏夹，权限必须保留。移除镜像后 `flattenBookmarks` 不再有排除参数，快照直接包含全部浏览器书签——语义回到「以浏览器为基准同步」。

### D5：零前缀需求由弹窗搜索承接

Chrome 扩展 omnibox 必须带关键字（官方文档明确要求 `omnibox.keyword`），没有「默认建议提供者」API；不写浏览器书签就无法在默认地址栏出现 StarNav 候选。因此零前缀体验落到弹窗：

- `popup.js` 初始化后 `browseSearch.focus()` + `select()`：`Ctrl+Shift+F` 打开即可直接输入，上次关键词全选、输入即替换（对齐地址栏选中态）。
- `browse-view.js` 搜索框 Enter：先 `clearTimeout` 再同步 `applyBrowseKeyword()`（否则 300ms 防抖未到期，`browseState` 还是旧关键词，会打开错误书签），然后 `openFirstBrowseMatch()` 复用条目点击路径（图标补全上报 + 跃迁反馈 + `tabs.create` + 关窗）。
- 空输入 Enter 不拦截，避免误开列表首条。

备选「自建弹窗页面 + 全局快捷键」被拒绝：MV3 无全局悬浮窗权限，`commands` 只能开 action popup 或新窗口，与现有弹窗重复。

### D6：契约收敛

`CONFIG_KEYS.sync` 删除 `mirrorBookmarks`、`STORAGE_KEYS` 删除 `BOOKMARK_MIRROR_FOLDER_ID`。旧配置中残留的 `mirrorBookmarks` 值不再被读取，也不主动清除（storage 无版本迁移机制，残留键无行为影响）。

## 风险与缓解

- **升级时误删用户文件夹**：只删除 storage 记录的 id；id 失效（用户已删）时 removeTree 抛错被吞。
- **用户已习惯 `sn`**：README 提示可改关键字；一次性行为变更，版本号 1.2.0 → 1.3.1；`sn` 用户可用弹窗搜索（Ctrl+Shift+F）替代。
- **`q` 与站内搜索快捷键冲突**：README 给出 `chrome://settings/searchEngines` 排查路径。
