## Context

插件右键「收藏当前网页到 xxx」目前是零交互直存：`background.js` `onClicked` 直接 `POST /api/sites`，`catelog` 取 options 的 `defaultCategory`（默认「未分类」）。用户希望收藏时先选分类再保存（grilling 定案：StarNav 分类、弹小窗、仅选分类、记忆上次、打开拉最新、小窗内查重、缩进树两层）。

MV3 约束：`contextMenus.onClicked` 回调中 `chrome.action.openPopup()` 有手势限制不可靠；`chrome.windows.create` 一定可用。

复用面（既有契约/纯逻辑，禁止拷贝）：
- `extension-contract.js`：`Contract.apiFetch`、`Contract.buildCollectPayload`、`Contract.normalizeBaseUrl`、`CONFIG_KEYS`、`MESSAGE_TYPES`
- `popup-logic.js`：`BrowseLogic.flattenCategoryTree`（分类树 → `[{name, level}]`）、`BrowseLogic.toggleCategory`/`injectAncestors`（手风琴状态机）
- 分类树接口：`GET /api/categories/tree`（popup 浏览视图同款）
- 查重接口：`GET /api/sites/check-duplicate?url=...`（collect-view 同款）
- 样式：popup.html 同款样式文件

## Goals / Non-Goals

**Goals:**
- 右键点击菜单 → 弹出小窗（`chrome.windows.create`，~340×480）选分类 → 保存 → 关窗 + 系统通知
- 分类树展示（父/子两层缩进），默认选中上次记忆分类（兜底 options 默认分类）
- 打开时拉最新分类树（`/api/categories/tree`），失败回退本地缓存
- 打开时查重，重复提示 + 「仍然保存」
- 未配置 baseUrl/token 时不弹窗，沿用现有通知提示

**Non-Goals:**
- 不在小窗内编辑名称/URL/标签/可见性（只选分类；完整表单仍在 popup 收藏视图）
- 不改服务端、不改主站、不改 `/api/sites` 契约
- 不做浏览器书签文件夹归档（那是书签同步域）
- 不保留"右键直存"快捷路径（用户明确要两步交互）

## Decisions

### D1. 弹窗机制：`chrome.windows.create` + 候选数据走 `storage.local`
右键点击时把 `{ url, name }` 写入 `storage.local` 键 `lastCollectCandidate`，随后 `chrome.windows.create({ url: 'collect-picker.html', type: 'popup', width: 340, height: 480, focused: true })`；小窗读取候选渲染。
- 备选：query 参数传 URL——URL 可能超长且有编码/泄露风险（URL 出现在窗口历史），否决。
- 备选：`chrome.action.openPopup()`——MV3 手势限制不可靠，否决。
- 小窗是普通扩展页面，共享扩展 storage/权限。

### D2. 分类数据：打开时拉 `GET /api/categories/tree` → `flattenCategoryTree`，失败回退 `storage.local.categories`
- 拉取成功 → 展平 `[{name, level}]` 渲染缩进树。
- 失败（网络/token 无效）→ 读 `storage.local.categories`（options「刷新分类/标签缓存」写的那份，元素含 `name`），映射 `level: 0`。
- 两者皆空 → 仅「未分类」一项（`defaultCategory` 兜底项）。
- 分类树接口在整站锁场景：`/api/categories/tree` 非白名单路由——但 token 有效即可访问（整站锁放行有效 Bearer）。与 popup 浏览视图同源，无新增风险。

### D3. 默认选中：`storage.local.lastCollectCategory` → `defaultCategory` → 「未分类」
- 保存成功时写 `lastCollectCategory`（所选分类名）。
- 无记忆 → options 的 `defaultCategory`；无配置 → 「未分类」。
- 记忆值不在当前分类树中（服务端删了分类）→ 回退 defaultCategory（渲染前校验所选值是否在列表内）。

### D4. 查重 + 强制保存：打开时并行 `check-duplicate`
- 打开即查（URL 来自候选，不变），重复 → 显示 `duplicateBox` 提示 + 「仍然保存」按钮（复用 popup 收藏视图样式与文案风格）。
- 「保存」→ `POST /api/sites`（`Contract.buildCollectPayload`，`catelog` = 所选分类）；409 竞态 → 通知 warning（复用现有文案）。

### D5. 保存后：小窗关窗 + background 统一通知
- 小窗内保存成功/失败/重复 → `sendMessage({ type: 'collect-result', ok, title, message })` → background `showNotification`（复用 `background.js` 现有实现，避免在小窗重复 notifications 逻辑）。
- 小窗自身 `window.close()`。
- 候选数据保存后清除 `lastCollectCandidate`（防残留重复弹窗）。

### D6. 菜单点击行为变更
`onClicked` 原保存逻辑整体移入小窗；`onClicked` 只做：读配置 → 无 baseUrl/token 则通知并 return → 写候选 → 开窗。`defaultCategory` 的读取保留给 D3 兜底。

### D7. 分类树渲染：两级缩进 + 手风琴
`level 0` 父分类（有子时带 ▸/▾），`level 1` 子分类缩进。复用 `BrowseLogic.toggleCategory`（单开手风琴）与 `injectAncestors` 语义；小窗初始全展开。

## Risks / Trade-offs

- **小窗是独立页面**：与 popup 不同的 DOM 树，无 `popup.js` 的 tab 状态机/配置装配——需自行 `loadConfig` 等价物（读 `CONFIG_KEYS` + storage.local）。工作量集中在 collect-picker.js 装配。
- **候选数据窗口期**：`lastCollectCandidate` 若被并发点击覆盖（连点两次菜单），后窗用后值——低概率、可接受；保存后清除降低残留。
- **整站锁 + 小窗 API**：小窗 API 调用与 popup 同款 token 鉴权，无新增面。
- **分类树陈旧**：拉取失败回退缓存可能看不到服务端新建分类——提示「分类可能不是最新，可在选项页刷新缓存」？不提示，静默回退（与浏览视图缓存语义一致）。
- **窗口焦点**：`focused: true` 可能被浏览器拦截弹窗策略？`windows.create` 无此限制（非 `window.open`）。
