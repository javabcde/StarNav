## 1. 菜单入口改造（background.js）

- [x] 1.1 `onClicked` 改为：读配置 → 无 baseUrl/token 沿用现有通知并 return → 写 `storage.local.lastCollectCandidate = { url, name, ts }` → `chrome.windows.create({ url: 'collect-picker.html', type: 'popup', width: 340, height: 480, focused: true })`（原直存逻辑整体移除）
- [x] 1.2 `onMessage` 新增 `collect-result` 分支：`{ ok, kind, message, category }` → 复用 `showNotification` 分级通知（success 收藏成功含分类名 / warning 重复 / error 服务端 / 网络错误），与现有文案对齐

## 2. 小窗页面与装配（collect-picker.html / collect-picker.js）

- [x] 2.1 `collect-picker.html`：页面骨架（标题/候选预览/分类列表区/重复提示区/保存按钮），引用 extension-contract.js、popup-logic.js、collect-picker.js 与 popup 同款样式（确认样式文件名后复用）
- [x] 2.2 `collect-picker.js` 装配：读 `lastCollectCandidate`（缺失则显示「未找到待收藏内容」+ 关闭按钮）→ 读 `CONFIG_KEYS.sync`（baseUrl/token/defaultCategory/siteName）→ 渲染候选名称/URL 只读
- [x] 2.3 分类树加载：`Contract.apiFetch('/api/categories/tree')` → `BrowseLogic.flattenCategoryTree` → `[{name, level}]`；失败回退 `storage.local.categories`（元素取 name，level 0）；两者皆空仅「未分类」
- [x] 2.4 渲染缩进树：level 0 父分类带 ▸/▾、level 1 子分类缩进；复用 `BrowseLogic.toggleCategory`/`injectAncestors` 手风琴语义，初始全展开
- [x] 2.5 默认选中：`storage.local.lastCollectCategory` → 校验仍在分类列表 → 否则 `defaultCategory` → 否则「未分类」；选中高亮
- [x] 2.6 查重：打开时 `GET /api/sites/check-duplicate?url=` → 重复显示 `duplicateBox` 提示（书签名+URL）+「仍然保存」按钮；不重复仅「保存」
- [x] 2.7 保存：`POST /api/sites`（`Contract.buildCollectPayload`，catelog=所选分类，desc 沿用「通过浏览器插件一键收藏」，visibility public，logo 沿用 `/api/favicon?url=` 源）→ 成功写 `lastCollectCategory`、清 `lastCollectCandidate`、`window.close()` + `sendMessage({type:'collect-result', ok:true,...})`；409 → 通知 warning 不关窗；其他错误通知 error 不关窗

## 3. 测试与回归

- [x] 3.1 picker 纯逻辑抽出（候选缺失处理、分类回退选择、默认选中解析与失效回退、记忆校验）→ `tests/collect-picker-logic.test.js`（node:test，中文用例，沿用 popup-logic.test.js 风格）
- [x] 3.2 源码断言回归锁：`tests/collect-picker-persist.test.js`——`background.js` onClicked 含 `windows.create` 且不再含 `buildCollectPayload` 直存调用；保存路径含 `lastCollectCategory` 写入与 `lastCollectCandidate` 清除（行首锚定，避免注释子串误绿）
- [x] 3.3 `node --check`（新增/改动文件）+ `npm test` 全量通过 + 中文提交推送

## 4. 产出物同步

- [ ] 4.1 实现与产出物对齐复查（proposal/design/specs/tasks 同步实现期补充）；tasks 全勾选后归档 `openspec/changes/archive/`
- [ ] 4.2 实测路径记录：右键网页 → 小窗 → 选分类 → 保存 → 关窗+通知；未配置路径通知不弹窗（扩展需手动重载验证）
