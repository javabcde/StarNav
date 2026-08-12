## Why

使用场景：用户装了 StarNav 浏览器插件，但每次浏览站内书签还得打开网站。插件目前只有「收藏当前页」与「一键同步」，缺一个高频入口——在弹窗里直接浏览、搜索、打开站内书签，不用打开网站。同时，读接口（`/search`、`/ai/chat`、`/config` GET）的私人书签可见性不认 Bearer Token，token 客户端（插件）看不到私人书签分类，浏览功能不完整。

## What Changes

- 新增 `extension-browse` 能力：插件弹窗改 Tab 布局（**浏览（默认）/ 收藏 / 同步**），浏览视图提供搜索、分类筛选、排序切换、加载更多与点击打开。
- 点击书签**直接打开原始 URL**（`chrome.tabs.create` 新标签，激活并关闭弹窗），不走站内 `/go` 跳转——锁站下新标签无解锁 Cookie 会 302 到锁页，且不计数（接受不计数）。
- 后端语义变更：**任何有效 Bearer Token 授予私人书签读取**——`api.js` 三处 `privateAccess` 计算（`/search`、`/ai/chat`、`/config` GET）加入 token 判定，私人书签分类对 token 客户端开放。token 是密码级凭据（见 ADR-0002）。
- 浏览视图细节：搜索防抖 300ms 统一走 `/api/config?keyword=`；分类胶囊横滚（含私人书签）；排序切换（默认站点序 / 热门 / 最近访问 / 名称）；「加载更多」分页（pageSize 30，按 total 判终止）；图标缺失显示首字母占位（不发外部请求）。
- 明确不做：多 space 切换、无限滚动、站内跳转计数、离线缓存、浏览→收藏联动。

## Capabilities

### New Capabilities

- `extension-browse`: 插件内站内书签浏览——Token 私人可见性、浏览视图（搜索/分类/排序/分页/打开）、Tab 布局。
