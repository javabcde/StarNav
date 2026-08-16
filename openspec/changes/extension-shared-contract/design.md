## Context

- popup.html 以 `<script src="popup-logic.js">` → `<script src="popup.js">` 顺序加载（经典 script，UMD 挂 `globalThis.BrowseLogic`）；options.html 只加载 options.js；manifest.json 的 service worker 为 classic（无 `type: module`）→ background.js 可用 `importScripts()`。
- `browse:cache:v1` 键：popup.js:569 与 background.js:4 各自声明；全量缓存形状 `{ kind:'full', fetchedAt, ttlMinutes, items, total, categories }` 在 popup.js / background.js 两处构造；TTL 默认 5 分出现三处（popup.js:570、background.js、options.js）。
- flattenCategoryTree 拷贝：background.js:7（注释「与 popup.flattenCategoryTree 同构」）对 popup-logic.js 的 `BrowseLogic.flattenCategoryTree`。
- 消息类型裸字符串：`ensure-favicon`（popup.js:690、background.js:173）、`sync-site-name`（options.js:119,219、background.js:167）；存储键 `favicon:debug:last`（background.js:223 写、popup.js:259,263 读删）；`browse:view:v1`（popup.js:892，browse-view-state-machine 变更共享）。
- 配置键：options.js / popup.js 读写 `baseUrl` / `token` / `defaultCategory` / `siteName` 等；background.js 的 warmBrowseCache 与 ensureFaviconForSite 已用新键，唯独右键收藏路径（99-101）读 `apiUrl` / `apiToken`（无人写入）→ 必失败。
- 保存路径：popup 收藏 POST `/api/sites`（表单全字段 + 409 查重 + force）；background 右键 POST `/api/config`（硬编码 `desc` / `visibility:'public'`、logo 拼 `/api/favicon?url=`、409 弹警告通知）。`getSiteRouteFlags`（handlers/api/sites.js:2-13）双路径均合法。
- apiFetch 三份：popup（config 驱动、无超时、错误由调用方查 code）；options（DOM 输入框读值、10s AbortController 超时、`!ok` 抛错、非 JSON 兜底）；background 内联 fetch + Authorization。

## Goals / Non-Goals

**Goals:**
- 扩展跨文件契约（缓存格式、消息/存储键、配置键、HTTP 客户端、收藏载荷）单一 owner，node:test 直测。
- 修复右键收藏必失败（配置键对齐），统一保存端点与载荷构建。
- background 删除 flattenCategoryTree 拷贝与内联形状检查。

**Non-Goals:**
- 不改动全量缓存数据结构本身（仍 `browse:cache:v1` + `kind:'full'`；旧格式不兼容语义维持）。
- 不做行为变更：各入口的请求时序、超时文案、409 处理、通知呈现逐一保持。
- 不新增契约模块对 chrome API 的依赖（保持纯逻辑，IO 由调用方做）。

## Decisions

### D1：契约模块形态——新建 `extension-contract.js`（UMD），popup-logic 零依赖
契约（键/形状常量/消息/HTTP/载荷）与浏览逻辑（缓存决策/手风琴/过滤）是两个关注点，分文件各保深度。popup-logic.js **保持零改动零依赖**（既有 popup-logic.test.js 以 vm 孤立加载 popup-logic.js，不挂任何全局——契约引用会崩）；background.js `importScripts('extension-contract.js', 'popup-logic.js')` 两文件，popup.html 加载顺序 `extension-contract.js` → `popup-logic.js` → `popup.js`，options.html 只加载 contract。
- 替代：扩展 popup-logic.js——14 个导出面被稀释；让 popup-logic 依赖全局 Contract——旧测试孤立加载即崩。

### D2：apiFetch 契约——默认无超时，!ok 抛错带 status/data（实现期修正）
`apiFetch(path, { baseUrl, token, timeoutMs, ...fetchOptions })`：拼接 URL（baseUrl 去尾斜杠）、鉴权头、可选 AbortController 超时（超时抛错保留 `name='AbortError'`，文案「连接超时（N 秒）…」）、非 JSON 文本兜底为 `{ raw }`；**`!ok` 时抛错并附带 `error.status` / `error.data`**（文案 `data.message || data.error || HTTP 状态`）——实现期发现 popup 原 apiFetch 即抛错（含站点名校验），「不抛错」为前提的假设有误；契约以抛错语义统一 popup/options 两处既有行为，零回归。popup.js / options.js 保留 7 行配置读取薄壳（popup 站点名校验文案、options 10s 超时），传输实现单一在契约。
- 替代：默认 10s + 统一超时——慢网络拉全量缓存可能被新超时打断，引入新 bug；不抛错——popup/options 既有调用面依赖抛错分支，改动即回归。

### D3：配置键干净改名，无兼容分支
background 右键收藏路径改读 `baseUrl` / `token`。旧键值无人写入已属过期数据；仓库惯例 clean cutover（AGENTS.md），不留双读 shim。
- 替代：双读兼容——契约模块带死分支，违反零行为变更目标。

### D4：保存路径统一 `/api/sites` + `buildCollectPayload`
`buildCollectPayload({ name, url, catelog, desc, visibility, logo, tags })` 唯一载荷构建；background 传 `desc:'通过浏览器插件一键收藏'`、`visibility:'public'`、logo 拼 `/api/favicon?url=`、`catelog: defaultCategory`（参数化，语义保留）；background 的 409 → 警告通知分支保留（基于响应 code 判断，与 popup 的查重弹窗各自呈现）。
- 替代：端点常量化双路径——只消灭字面量，不消灭双写路径。

### D5：形状守卫留 popup-logic，契约只收键/形状常量
`isFullBrowseCache` / `flattenCategoryTree` 属浏览决策逻辑，留在 popup-logic.js（导出面不变，旧测试零改动）；background 两处内联 `cache.kind === 'full' && Array.isArray(cache.items)`（189、231）改调 `BrowseLogic.isFullBrowseCache`，flattenCategoryTree 拷贝删除。契约模块只持有缓存键与形状**常量**（`browse:cache:v1`、TTL 默认、字段清单）。
- 替代：守卫迁入 contract + popup-logic 挂全局 re-export——popup-logic.test.js 的 vm 孤立加载无 Contract 全局，旧测试破坏，违反「旧测试不动」约束。

## Risks / Trade-offs

- **加载顺序依赖**：popup.html 三 script 顺序错误会破坏全局引用——以 popup-logic 的既有模式（UMD 挂全局）为模板，加载顺序写入两处注释（popup.html、background.js importScripts 行）。
- **右键收藏行为面**：从「必失败」变「可用」是修复；其余（desc/visibility/409/通知）逐项保留，靠 options/background 改动后人工冒烟确认。
- **消息类型字符串化**：消息类型常量化后，background 的 `message.type !== 'ensure-favicon'` 判断面同步更新——grep 全量消息字面量防漏。
- **契约模块纯逻辑约束**：不碰 chrome API，测试保持 vm 加载直测。
