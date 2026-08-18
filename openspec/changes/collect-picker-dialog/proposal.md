## Why

右键「收藏当前网页到 xxx」目前是零交互一键直存——直接落到 options 配置的默认分类（默认「未分类」），用户无法在收藏时选择目标分类，经常存错夹子后再手动改。把收藏目标选择权还给用户：右键后先弹小窗选分类，再保存。

## What Changes

- 右键菜单点击行为变更（**BREAKING**：不再直接保存）：`contextMenus.onClicked` 中把待收藏的 `{ url, name }` 暂存 `storage.local`（`lastCollectCandidate`），然后 `chrome.windows.create` 弹出 ~320px 小窗（新增 `collect-picker.html/js`）。
- 小窗展示**分类缩进树**（父分类展开显示子分类，两层）：打开时经 token 拉最新分类树（`/api/config?all=1`），失败回退 options 缓存的 `storage.local.categories`，两者皆空则仅「未分类」兜底。
- 小窗默认选中：记忆的上次右键选择（`storage.local` 键 `lastCollectCategory`）→ 兜底 options 默认分类。
- 名称/URL 自动预填（页面标题 + `pageUrl` / 链接文字 + `linkUrl`），**不可编辑**；仅分类选择 + 「保存」按钮。
- 打开时查重（`/api/sites/check-duplicate?url=...`）：重复则显示提示 + 「仍然保存」按钮（与 popup 收藏视图一致）。
- 保存：`POST /api/sites`（复用 `Contract.buildCollectPayload`，`catelog` 取所选分类）→ 记 `lastCollectCategory` → 关窗 + 系统通知（成功/重复/失败沿用现有 `showNotification` 文案）。
- 未配置 baseUrl/token：不弹窗，沿用现有系统通知提示去配置。
- 服务端与主站无任何改动。

## Capabilities

### New Capabilities

- `collect-picker`: 右键收藏分类选择——右键菜单点击后弹小窗选分类再保存；分类树展示/默认记忆/查重强制保存/自动关窗通知。

### Modified Capabilities

无（既有 spec 无行为变更；插件右键收藏入口行为属新能力范畴）。
