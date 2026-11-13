## 1. 纯逻辑模块

- [x] 1.1 新建 `extensions/browser-bookmark/omnibox-logic.js`（UMD）：`isSafeNavUrl`（仅 http/https）、`searchOmniboxItems`（多词全命中、字段加权、hits 兜底、同 URL 去重、limit）、`buildOmniboxSuggestions`（content=URL、description 含 `<match>`/`<url>`/`<dim>`）、`normalizeOmniboxTarget`（完整 URL / 裸域名 / 关键词）、`renderDefaultSuggestion`
- [x] 1.2 复用 `Contract.escapeHTML` 做 XML 转义（不复制实现）；名称/URL/元信息分别截断 60/100/50

## 2. manifest 与 background 接线

- [x] 2.1 `manifest.json` 增加 `"omnibox": { "keyword": "sn" }`，版本 1.0.0 → 1.1.0（无需新增权限）
- [x] 2.2 `background.js` 的 `importScripts` 追加 `omnibox-logic.js`
- [x] 2.3 缓存链路抽成 `readBrowseCache` / `refreshBrowseCache` / `refreshBrowseCacheOnce`（并发去重、失败返回 null），`warmBrowseCache` 改为薄壳
- [x] 2.4 注册 `onInputStarted`（缓存缺失/过期预取）、`onInputChanged`（读缓存出建议；缺失时等待 ≤1.5s；过期时后台刷新 + 15s 节流）、`onInputEntered`（URL/最佳匹配/首页/选项页分流）
- [x] 2.5 `navigateOmniboxUrl` 映射三种 disposition：`tabs.update` / `tabs.create(active:true)` / `tabs.create(active:false)`；非 http(s) 不导航

## 3. 测试与文档

- [x] 3.1 新增 `tests/omnibox-logic.test.js`：安全 URL、匹配优先级、多词全命中、URL/分类/标签命中、去重/limit/空输入、建议描述转义与高亮、目标判定、默认文案
- [x] 3.2 更新 `extensions/browser-bookmark/README.md`（功能特性 + 地址栏搜索用法）
- [x] 3.3 更新 `CONTEXT.md` 术语：地址栏搜索 (Omnibox Search)

## 4. 验证

- [x] 4.1 `node --test tests/omnibox-logic.test.js` 全绿（9/9）
- [x] 4.2 模拟 background 环境冒烟：onInputChanged 返回值/默认文案/安全过滤、onInputEntered 的当前页/新标签/裸域名/首页回退
- [x] 4.3 CatsXP 真实加载未打包扩展：service worker 启动、manifest 版本 1.1.0、omnibox 关键字 `sn`、三个 omnibox 监听器均已注册、`OmniboxLogic` 在 SW 全局可用
- [x] 4.4 `npm run quality` 全绿
