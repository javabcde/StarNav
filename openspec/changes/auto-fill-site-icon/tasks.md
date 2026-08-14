## 1. 服务端核心

- [x] 1.1 siteService 新增 `ensureSiteFavicon(env, site)`：logo 非空短路、KV `favicon:failed:{id}` 短路、getFavicon 抓取写回/失败标记（无 TTL）
- [x] 1.2 `/go/:id`：`if (!site.logo)` 追加 `ctx.waitUntil(ensureSiteFavicon(...).catch(log))`，与 incrementSiteHits 并列
- [x] 1.3 api.js 新增 `POST /api/site/:id/ensure-favicon`：requireAdmin allowApiToken scope=write + id 校验 + 返回 `{ updated, favicon, reason }`
- [x] 1.4 `bulkRefreshSiteFavicons` 处理每站后删除 KV 失败标记（手动刷新重置）
- [x] 1.5 `updateSite` 编辑时删除 KV 失败标记（手动操作重置）

## 2. 插件链路

- [x] 2.1 background.js 新增 `chrome.runtime.onMessage`：`ensure-favicon` 消息 → 查缓存该条 logo 已非空直接返回；否则带 token 调接口（28s 超时，异常区分 timeout/network）→ 拿到 favicon URL 时 patch `items[i].logo` 写回 chrome.storage.local
- [x] 2.2 popup.js 浏览列表点击：该条缓存 logo 空时 fire-and-forget `sendMessage({type:'ensure-favicon', siteId})`

## 3. 测试与验证

- [x] 3.1 siteService 测试：ensureSiteFavicon 三分支（has-logo 跳过 / 成功写回 / 失败标记永久）+ 标记存在时跳过
- [x] 3.2 go.test：无 logo 书签点击触发 ensure（mock getFavicon）且不阻塞跳转；有 logo 不触发
- [x] 3.3 api 测试：ensure-favicon 无凭据 401/403、token 可调返回 updated/favicon
- [x] 3.4 语法检查全部改动文件 + 全量测试套件（117/117 全绿）

## 4. 收尾

- [x] 4.1 CONTEXT.md 术语已写入（站点图标 / 图标自动补全）
- [x] 4.2 git 中文提交并推送（f5dcd7d，后续修复链 7100849~2692765 随实现推送）

## 5. 实现期补充（诊断与 review 驱动）

- [x] 5.1 getFavicon 每源 5s 超时 + background 接口超时 28s（大于服务端 6 源最坏 30s 的折中，慢站可收敛）
- [x] 5.2 失败原因可见化：background 写 `favicon:debug:last`（原因+http 状态），popup 打开显示；review 修复后置于就绪提示之后、异常路径（timeout/network）也记录
- [x] 5.3 has-logo 分支返回现有 URL：插件缓存拿到 URL 即本地 patch（双入口补全后缓存立即对齐，不误报失败）
- [x] 5.4 getFavicon 第 6 源：safeFetch 抓源站 HTML 解析 `<link rel=icon>`（自定义路径 favicon；真实站点复现：/favicon.ico 404 + 聚合源未收录）；`extractHtmlFavicon` 纯函数与 fetchSitePreview 共用；SSRF 防护对私有 IP 仍拒绝（内网站需手动填 logo）
- [x] 5.5 新 token 写端点列入 /api discovery/openapi.json（review F5）
