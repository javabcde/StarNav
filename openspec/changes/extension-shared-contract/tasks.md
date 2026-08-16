## 1. 契约模块

- [x] 1.1 新建 `extensions/browser-bookmark/extension-contract.js`（UMD）：`BROWSE_CACHE_KEY` / 全量缓存形状常量 / `BROWSE_CACHE_DEFAULT_MINUTES`、`MESSAGE_TYPES`（ensure-favicon / sync-site-name）、存储键（`favicon:debug:last` / `browse:view:v1`）、配置键清单、`apiFetch(path, { baseUrl, token, timeoutMs })`（默认无超时、非 JSON 兜底 `{ raw }`、!ok 抛错带 status/data——实现期修正：popup 原实现即抛错，零回归）、`buildCollectPayload`（不含形状守卫/展平函数——留在 popup-logic）
- [x] 1.2 popup-logic.js 零改动（不依赖 Contract 全局——既有 popup-logic.test.js 以 vm 孤立加载，旧测试必须原样通过）
- [x] 1.3 新增 `tests/extension-contract.test.js`（vm 加载 UMD）：缓存键/形状常量、apiFetch 拼 URL/鉴权头/超时/非 JSON/抛错语义、buildCollectPayload 默认与覆盖、消息/存储键常量

## 2. popup.js 接线

- [x] 2.1 popup.html 在 popup-logic.js 前加载 `extension-contract.js`；popup.js 的 `BROWSE_CACHE_KEY` / `BROWSE_CACHE_DEFAULT_MINUTES` / `BROWSE_VIEW_KEY` / `favicon:debug:last` / 消息类型裸字符串改引用契约
- [x] 2.2 popup.js `apiFetch` 改薄壳（配置校验文案保留 + 委托 `Contract.apiFetch` 传输；authHeaders 删除）

## 3. background.js 接线

- [x] 3.1 顶部 `importScripts('extension-contract.js', 'popup-logic.js')`；删除本地 `BROWSE_CACHE_KEY` / flattenCategoryTree 拷贝 / 内联 `kind==='full'` 检查（改调 `BrowseLogic.isFullBrowseCache`）
- [x] 3.2 右键收藏路径：配置键改 `baseUrl` / `token`；载荷改 `Contract.buildCollectPayload`（desc/visibility/logo/catelog 参数化）；端点改 `/api/sites`；409 经 error.status/data 走警告通知
- [x] 3.3 消息类型字面量改 `Contract.MESSAGE_TYPES`；`favicon:debug:last` 改契约常量；warmBrowseCache / ensureFaviconForSite 的 fetch 改 `Contract.apiFetch`（28s 超时语义保留）
- [x] 3.4 新契约单测覆盖 buildCollectPayload 的 background 默认参数组合（desc/visibility/catelog）

## 4. options.js 接线

- [x] 4.1 options.html 加载 `extension-contract.js`；options.js `apiFetch` 改薄壳（10s 超时语义保留）；TTL 默认与 `normalizeBaseUrl` 改引用契约；authHeaders 删除
- [x] 4.2 实现期补充（advisory 驱动）：新增 `tests/options-config-persist.test.js` 源码回归锁——token 回填/持久化、browseCacheMinutes 默认值引用契约常量（options.js 无运行 seam，此前 TTL 编辑误删 token 行 quality 未拦下）

## 5. 验证与收尾

- [x] 5.1 `npm run quality` 全绿（154/154：含 12 个新 contract 测试，旧测试零改动）
- [x] 5.2 冒烟：CatsXP（E:\catsxp\catsxp.exe）加载未打包扩展——popup 三 tab 渲染零 JS 错误、「未配置」提示来自 apiFetch 薄壳；扩展管理器无错误；消息唤醒 background SW 成功（importScripts 两文件正常）。注意：browser 工具的追加参数覆盖了 user-data-dir，冒烟实例实际运行于 `E:\catsxp\User Data`（仅产生少量历史/会话文件，未安装扩展——load-extension 会话级、实例已退出，5.4 需用户在真实浏览器手动加载）
- [ ] 5.4 右键收藏完整流程由用户手动验证（配置 API 地址后右键 → 收藏成功/重复警告）
- [ ] 5.5 中文提交（git）
