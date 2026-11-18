## Why

插件已有站内书签全量缓存（`browse:cache:v1`），但入口只在弹窗里：想打开一个收藏，必须先点扩展图标、等弹窗渲染、再输入关键词。浏览器地址栏是最高频入口，支持关键字搜索可以在两次按键内直达收藏，并且完全复用现有缓存与匹配数据，不需要服务端新增接口。

## What Changes

- `manifest.json` 注册 `omnibox.keyword = "sn"`（无需新增权限），版本 1.0.0 → 1.1.0。
- 新增 `omnibox-logic.js`（UMD 纯逻辑，node:test 可直接加载）：多词匹配/排序/同 URL 去重/仅 http(s) 过滤；建议描述 XML 转义与 `<match>`/`<url>`/`<dim>` 标记；回车目标判定（完整 URL / 裸域名 / 关键词）；默认建议文案。
- `background.js` 注册 `chrome.omnibox` 三个事件：
  - `onInputStarted`：缓存缺失或过期时预取；
  - `onInputChanged`：读全量缓存出建议，零网络请求；缓存缺失时等待一次拉取（≤1.5s），过期时先用旧数据并在后台刷新（15s 节流 + 并发去重）；
  - `onInputEntered`：选中候选打开原始 URL；直接回车按 URL/关键词/首页分流；未配置时打开选项页；`currentTab`/`newForegroundTab`/`newBackgroundTab` 分别映射 `tabs.update`/`tabs.create(active:true/false)`。
- 缓存预热链路抽成 `readBrowseCache` / `refreshBrowseCache` / `refreshBrowseCacheOnce`，安装与启动预热、地址栏预取共用同一条去重拉取。
- 不动服务端 API、不动 popup、不改全量缓存形状。

## Capabilities

### New Capabilities

- `extension-omnibox`: 浏览器地址栏关键字搜索站内书签。

### Modified Capabilities

- 无。复用 `extension-browse` 的全量缓存与 TTL 语义，不改变其行为。
