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

### D3：omnibox 关键字定为 `q`，接受 Brave 不可用

单字符、输入成本最低；Chrome/Edge 按 Chrome 文档支持 `keyword + 空格/Tab`。

Brave 1.98（Chromium 156）实测：关键字模式可进入、回车能收到 `onInputEntered`（文本已剥离关键字），但 `onInputStarted`/`onInputChanged` 完全不派发，下拉必为空白。用一个 30 行、只注册三个监听器的最小探针扩展复现同样现象，确认与 StarNav 代码无关，是 Brave 的 omnibox 实现问题。

曾尝试双字符 `qq` 做 A/B，同样只收到 Enter 事件，排除「单字符关键字被忽略」的假设，关键字恢复为 `q`。曾实现弹窗搜索（打开即聚焦、Enter 直开首条）作为 Brave 替代路径，用户明确表示不要该功能，已移除；浏览视图恢复原行为。

备选「把收藏镜像到浏览器书签换取 Brave 原生联想」仍被否决（即本次变更要删除的方案）。

### D4：保留 `bookmarks` 权限与一键同步

「同步」视图仍用 `chrome.bookmarks.getTree()` 读取浏览器收藏夹，权限必须保留。移除镜像后 `flattenBookmarks` 不再有排除参数，快照直接包含全部浏览器书签——语义回到「以浏览器为基准同步」。

### D5：地址栏建议同步交付（内存快照）

`onInputChanged` 里等 `await`（storage 读取/网络拉取）之后再 `suggest`/`setDefaultSuggestion` 会依赖浏览器是否接受延迟建议。改为：service worker 维护内存缓存快照（读取/刷新/`storage.onChanged` 三处更新），快照就绪时在同一回调内同步交付默认行与候选；无快照的冷启动仍先同步给「正在加载」默认行 + 空建议，再异步补齐。`setDefaultSuggestion` 包 try/catch，避免默认行失败拖累候选。

### D6：关键字模式自检

`onInputStarted` 即设置默认行（有快照显示「输入关键词搜索 StarNav 收藏（共 N 条）」，无快照显示「正在加载收藏缓存…」）。这条默认行是判断「关键字模式是否由本扩展接管」的可见信号；调试用的 `[StarNav]` 事件日志已在定位完成后移除。

### D7：契约收敛

`CONFIG_KEYS.sync` 删除 `mirrorBookmarks`、`STORAGE_KEYS` 删除 `BOOKMARK_MIRROR_FOLDER_ID`。旧配置中残留的 `mirrorBookmarks` 值不再被读取，也不主动清除（storage 无版本迁移机制，残留键无行为影响）。

## 风险与缓解

- **升级时误删用户文件夹**：只删除 storage 记录的 id；id 失效（用户已删）时 removeTree 抛错被吞。
- **Brave 用户无法使用地址栏候选**：已在 README 顶部说明；不提供弹窗替代（用户决定）。
- **用户已习惯 `sn`**：README 提示可改关键字；一次性行为变更，版本号 1.2.0 → 1.3.5。
- **`q` 与站点搜索快捷键冲突**：README 给出 `chrome://settings/searchEngines` 排查路径。
