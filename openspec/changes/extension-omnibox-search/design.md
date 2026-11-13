## Context

- 插件 MV3 classic service worker（`background.js`）已通过 `importScripts` 加载 `extension-contract.js`（缓存键/形状/HTTP 客户端）与 `popup-logic.js`（`isFullBrowseCache` / `isBrowseCacheFresh` / `fetchFullBrowseCache`）。
- 全量缓存 `browse:cache:v1` 存在 `chrome.storage.local`，包含当前 token 可见的全部书签（`items`）、分类树与 `fetchedAt`/`ttlMinutes`。popup 站内浏览与服务端接口不感知地址栏搜索。
- `chrome.omnibox` 只需 manifest 的 `omnibox.keyword`，不需要额外权限；`chrome.tabs.update/create` 只写 URL，不需要 `tabs` 权限。
- 地址栏建议的 `description` 是 XML：用户数据必须转义，标记只允许 `<match>`/`<url>`/`<dim>`。

## Goals / Non-Goals

**Goals:**

- 地址栏 `sn` + 空格后按标题、URL、分类、标签搜索站内书签。
- 常规输入零网络请求：建议直接来自全量缓存。
- 首次使用无缓存也能搜：等待一次拉取（上限 1.5s），超时后下次输入命中。
- 选中候选直接打开原始 URL（与 popup 站内浏览一致：不经 `/go`、不计数）。
- 键盘语义完整：当前页 / 新前台标签 / 新后台标签；无匹配回车回 StarNav 首页；直接输入域名按网址打开。

**Non-Goals:**

- 不做服务端搜索接口或远程联想（保持零新增 API）。
- 不做拼音/首字母/模糊纠错（与 popup 现有客户端过滤的匹配面保持一致，另加标签与排序）。
- 不改 popup 视觉与交互；不新增缓存格式。
- 不做地址栏历史记录/搜索词统计。

## Decisions

1. **独立纯逻辑模块 `omnibox-logic.js`（UMD）**。
   匹配排序、建议描述、目标判定都需要单测，且 background 无法在 node:test 直接跑。沿用 `popup-logic.js` 的 vm 加载模式；模块只依赖全局 `Contract.escapeHTML`（不复制转义实现）。备选：把函数塞进 `popup-logic.js`——职责混杂且 popup 用不到，拒绝。

2. **建议来自全量缓存，不调 `/api/search`**。
   `/api/search` 有搜索评分与搜索词统计，但地址栏每次按键都请求会放大延迟与服务端负载；全量缓存已包含全部可见书签。排序在客户端完成：名称精确 (1000) > 前缀 (700) > 包含 (500) > URL (300) > 分类 (150) > 标签 (120)，多词全命中后按词加分，最后 hits 降序、名称升序。最多 8 条，同 URL 去重，仅保留 http(s)。

3. **缓存缺失时等待一次拉取，过期时先旧后新**。
   `refreshBrowseCacheOnce` 复用安装/启动预热链路并做并发去重；`onInputChanged` 与 `onInputEntered` 无缓存时都用 `Promise.race` 拉取与 1.5s 超时（输入路径超时先返回空建议，回车路径超时回退首页）。过期缓存直接用于本次建议，`refreshBrowseCacheIfNeeded` 在后台刷新，并加 15s 节流，避免 `browseCacheMinutes=0`（不缓存配置）时每次按键都全量请求。备选：每次输入都等全量拉取——不可接受的首键延迟。

4. **回车目标按输入形态分流**。
   完整 `http(s)://` 原样导航；裸域名（正则含子域/端口/路径）补 `https://`；其余取本地最佳匹配；仍无匹配则打开配置的 StarNav 首页；完全未配置则 `openOptionsPage()`。非 http(s) scheme（`javascript:`/`data:`/`ftp:`）一律不导航，按关键词处理——防止被污染的站点数据进入地址栏。

5. **建议描述先转义再插标记**。
   名称中命中段包 `<match>`，URL 用 `<url>` 灰显，分类/标签用 `<dim>`；所有用户字段先经 `Contract.escapeHTML`，避免 `&`/`<`/`>` 破坏 XML 或被解释成标记。名称截断 60 字、URL 截断 100 字（中间省略）、元信息 50 字。

## Risks / Trade-offs

- **缓存未命中 = 搜不到**：地址栏只读本地全量缓存，极端情况下缓存拉取失败会显示无匹配。缓解：无匹配文案明确提示回车回首页，popup 手动刷新可恢复。
- **缓存 TTL 过期数据**：默认 5 分钟，过期后本次建议可能包含已删除书签。缓解：后台刷新 + 15s 节流；打开候选仍由服务端最终返回（若是首页）。
- **`description` XML 兼容性**：仅使用 Chrome 文档支持的 `<match>`/`<url>`/`<dim>`；数值实体由 `escapeHTML` 提供。
- **地址栏关键字冲突**：`sn` 可能与用户已装扩展冲突，Chrome 会提示关键字被占用；可后续在 options 中做成可配置，当前不做。
- **无权限新增**：`tabs.create/update` 不需要 `tabs` 权限；若未来读取标签页标题才需要重新评估。
