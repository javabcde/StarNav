## Why

站点图标（`sites.logo`）只在添加书签时手动抓取或靠 admin 批量刷新，大量旧书签/同步来的书签永远没有图标。点击书签是用户最自然的触达点，此时站点 URL 与权限上下文都已在手——顺路补一次图标成本极低，却能让整个导航站图标逐步自愈。

## What Changes

- `/go/:id` 跳转时，若目标书签无图标且未被标记为"抓取失败"，后台异步抓取 favicon 并写回 `logo`（不阻塞跳转，失败静默）。
- 新增接口 `POST /api/site/:id/ensure-favicon`（API token 可调，scope=write）：服务端幂等判断——有图标跳过、已标记失败跳过、否则抓取写回；返回 `{ updated, favicon, reason }`。
- 抓取失败的站点以 KV 标记 `favicon:failed:{id}`（无 TTL）**永久放弃**自动重试；admin 批量刷新图标、编辑书签时清标记重置。
- 插件站内浏览点击书签：若缓存中该条无图标，经 background 上报 `ensure-favicon`；成功后将返回的 favicon URL **本地 patch** 进 full cache 该条（chrome.storage.local 共享，零额外全量请求）。
- 主站首页显示：不 purge 边缘缓存，靠 s-maxage=60 自动过期（≤1 分钟全视图更新）。

## Capabilities

### New Capabilities

- `site-icon-auto-fill`: 站点图标自动补全——点击路径（主站 `/go/:id`、插件站内浏览）触发的一次性后台补全；有图标跳过、失败永久放弃（仅手动操作重置）、不阻塞跳转。

### Modified Capabilities

无（既有 spec 无行为变更；`/go` 与插件行为属于新能力范畴）。
