# 星漫旅站 - Cloudflare Workers 书签导航系统

> 基于 Cloudflare Workers + D1 + KV 的书签导航系统。前台多布局展示、后台管理、访客提交审核、系统公告、私人书签、AI 书签助理、浏览器插件、一键同步浏览器收藏。

本项目从 [wangwangit/nav](https://github.com/wangwangit/nav) 迭代而来，已从早期单文件 Worker 改造为模块化架构，适合作为个人导航站、团队工具导航站或轻量级书签管理系统长期维护。

## 🖼️ 界面预览

![首页预览](https://img.110995.xyz/file/blog/34kEoYV9.png)

首页：分类导航、搜索、标签筛选、主题切换、多布局、AI 助理、访客提交入口。

![登录预览](https://img.110995.xyz/file/blog/T0Im9zqj.png)

后台登录使用 Cookie 会话，不在 URL 中暴露登录凭据。

![后台预览](https://img.110995.xyz/file/blog/DjI70oWp.png)

后台：书签管理、分类管理、提交审核、系统设置、AI 配置、备份恢复、API Token、WebHook。

## ✨ 核心特性

- 📚 **书签导航首页**：展示名称、链接、Logo、描述、分类、标签、访问次数。
- 🎨 **前台个性化**：主题颜色、深色模式、密度、背景风格、显示模式和布局切换。
- 🧩 **多布局**：卡片、列表、分组、瀑布流、概览面板。
- 🔍 **全站搜索**：支持高级语法、中文 n-gram、首字母召回和可解释排序。
- 📂 **父子分类**：层级、排序、父分类设置、展开/收起。
- 🏷️ **标签系统**：书签打标签，前台按标签筛选。
- 🔥 **热门与最近访问**：按访问次数、最近访问时间查看。
- 🔐 **私人书签**：固定分类需密码访问，管理员直接可见。
- 🔒 **整站锁**：部署级门禁，默认关闭。后台设置访问密码即启用，除后台登录、静态与 PWA 资源外全站需解锁；管理员免锁。
- 📝 **访客提交审核**：访客提交新书签，管理员审核后展示。
- ✅ **后台管理**：新增、编辑、删除、批量修改、批量删除、批量检测。
- 🧭 **前台管理员编辑**：登录后可在前台直接编辑、删除、拖拽排序。
- 🧪 **链接健康检测**：单个或批量检测书签链接可用性。
- 📊 **提交分析**：提交趋势、热力图、分类占比、质量分析、异常波动。
- 🤖 **AI 书签助理**：前台悬浮助理，优先检索本站书签，可接 OpenAI 兼容接口。
- ⚙️ **系统设置**：网站名称、副标题、图标、页脚、系统公告、AI 参数。
- 🖼️ **图标自动获取**：新增书签时自动抓取 favicon。
- 🔄 **前后台同步刷新**：后台变更后，已打开的前台页面自动刷新。
- 📤 **导入导出**：新版/旧版结构、HTML/CSV 导出、旧 config.json 导入。
- 💾 **备份恢复**：手动/定时备份、最近 30 份滚动保留、覆盖/合并恢复、恢复前快照。
- 🌐 **PWA**：manifest 和 service worker，移动端添加到主屏幕、离线缓存、更新提示。
- 🔌 **开放 API**：公开只读接口、API 发现、OpenAPI 描述、Bearer Token 写入。
- 🧩 **浏览器插件**：MV3 插件，Token 快速收藏当前网页。
- 🔄 **一键同步浏览器书签**：以浏览器收藏为事实源对齐（新增/改名/换分类/删除随浏览器），手动书签永不覆盖；插件一键 + 后台 bookmarks.html 上传双入口，删除前确认、写操作日志、空快照自动拦截。
- 🪝 **WebHook**：写操作基于操作日志异步触发，事件匹配 + HMAC 签名。
- 🧪 **工程质量基线**：语法检查、Node.js 测试、GitHub Actions 质量检查。
- 🌏 **i18n 基础**：前台文本具备多语言扩展基础。
- 🧱 **模块化架构**：路由、页面、服务、工具库分层。

## 🚀 快速部署

### 自动部署（GitHub Actions）

仓库内置 `deploy.yml`：push 到 `main` 自动构建并部署到 Worker（`name = "homepage"`），并幂等执行 `schema.sql` 初始化。首次使用在 GitHub 仓库 **Settings → Secrets and variables → Actions** 配置 4 个密钥：

| Secret | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token（模板「Edit Cloudflare Workers」+ D1 编辑 + KV 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号 ID（dashboard 首页右下角） |
| `D1_DATABASE_ID` | D1 `homepage` 的 `database_id` |
| `KV_NAMESPACE_ID` | KV `NAV_AUTH` 的 namespace `id` |

配置后 push 即自动部署。仓库内 `wrangler.toml` 保持占位符，真实 ID 只存在 Secrets。管理员账号仍需手动写入 KV `NAV_AUTH`（见下方步骤 5）。

### Wrangler 手动部署

```bash
# 1. 安装依赖
npm install

# 2. 创建 D1 数据库，把生成的 database_id 写入 wrangler.toml
npx wrangler d1 create homepage

# 3. 初始化数据库
npx wrangler d1 execute homepage --file=schema.sql --remote

# 4. 创建 KV 命名空间，把生成的 id 写入 wrangler.toml
npx wrangler kv namespace create NAV_AUTH

# 5. 设置管理员账号（也可在 Cloudflare KV 控制台添加）
npx wrangler kv key put admin_username admin --binding=NAV_AUTH --remote
npx wrangler kv key put admin_password your-password --binding=NAV_AUTH --remote

# 6. 本地检查
npm run quality

# 7. 部署
npx wrangler deploy
```

### 部署后

先访问 `https://你的域名/admin` 登录管理员，添加一个书签再回前台，否则前台没有内容可看。部署前可对照 [docs/deployment-checklist.md](docs/deployment-checklist.md) 逐项确认 D1、KV、管理员账号、API Token、WebHook、Cron Trigger 和备份策略。

## 🧩 浏览器插件

内置 Manifest V3 插件（`extensions/browser-bookmark/`），完整教程见 [docs/browser-extension-guide.md](docs/browser-extension-guide.md)。

插件能力：

- 收藏当前网页到 StarNav（查重、可强制保存，自动抓取标题/描述/favicon，AI 推荐分类和标签）。
- **站内书签浏览**：弹窗 Tab 视图（浏览/收藏/同步），搜索、分类筛选、排序、加载更多，点击直接打开原始 URL，不用打开网站。
- **一键同步浏览器收藏**：以浏览器收藏为事实源对齐同步书签，手动书签永不覆盖。浏览器删了书签，同步书签也会删除（先写操作日志）；手动改过的同步书签会被浏览器状态覆盖，想保留就在后台「解除同步」转手动。后台「数据管理」页支持上传 `bookmarks.html` 执行同样的全量对齐，删除前有确认框；浏览器收藏为空时同步被拦截。
- 使用 Bearer Token 写入书签，不依赖后台 Cookie。

加载方式：`chrome://extensions` 开启开发者模式 → 「加载已解压的扩展程序」→ 选择 `extensions/browser-bookmark/` 目录 → 插件设置页填写 StarNav 地址和 Bearer Token。正式发布包见 GitHub Releases。

## 🔌 API 与第三方接入

完整说明见 [docs/api-guide.md](docs/api-guide.md)。

公开只读接口（匿名可访问，按权限过滤私密/隐藏书签）：

- `GET /api/sites`：书签列表，支持分页、分类、标签、关键词、排序、健康状态筛选。
- `GET /api/categories`、`GET /api/categories/tree`：分类列表与树。
- `GET /api/tags`：标签列表与使用次数。
- `GET /api/search`：高级搜索，支持 `tag:`、`cat:`/`category:`、`url:`、`is:` 语法。
- `GET /api/settings/public`：站点公开设置。
- `POST /api/ai/chat`：AI 书签助理。
- `GET /api/favicon?url=`：获取指定 URL 的 favicon。

条件开放接口（管理员 Cookie，部分支持 Bearer Token `write` scope 或公开提交）：

- `POST /api/sites`、`PUT /api/sites/:id`、`DELETE /api/sites/:id`：书签增改删。
- `GET /api/sites/check-duplicate?url=&excludeId=`：URL 查重。
- `GET /api/site/preview?url=`：抓取标题、描述、favicon 并查重。
- `POST /api/submit/suggest-category`、`POST /api/submit/suggest-tags`：AI 推荐分类/标签。

发现与 OpenAPI：`GET /api`、`GET /api/discovery`、`GET /api/openapi.json`。发现端点返回公开/条件开放端点清单、鉴权状态与参数说明；OpenAPI 3.0.3 描述可导入 Postman、Apifox。

Bearer Token：后台 Token 管理创建，明文只在创建时显示一次，KV 只存哈希和脱敏元数据。scope 分 `read`（预留）、`write`（写入/维护接口）、`admin`（覆盖普通 scope 校验，但管不了系统敏感配置、WebHook 和 Token 自身）。

```bash
curl -X POST "https://你的域名/api/sites" \
  -H "Authorization: Bearer nav_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Example",
    "url": "https://example.com",
    "catelog": "工具",
    "tags": ["示例", "工具"],
    "visibility": "public"
  }'
```

## 🪝 WebHook

基于操作日志异步触发：新增/修改/删除书签、分类、标签、备份、审核等写操作落日志后按配置发送事件。完整说明见 [docs/webhook-guide.md](docs/webhook-guide.md)。

- 配置存 KV，管理接口仅管理员 Cookie 可访问，支持启用/停用和测试发送。
- 事件匹配：`*`、精确 action（如 `site.create`）、分组通配（如 `site.*`）。
- 仅 HTTPS URL，可选 secret，请求头带 `X-StarNav-Signature: sha256=<hmac>`。
- 记录最后触发时间、状态码和错误。

管理接口：`GET/POST /api/webhooks`、`PUT/DELETE /api/webhooks/:id`、`POST /api/webhooks/:id/test`。

## 📤 数据导入导出与备份

完整说明见 [docs/backup-restore-guide.md](docs/backup-restore-guide.md)。

- **导入**：预览（统计总数/有效/无效/重复/缺失分类），合并导入按归一化 URL 跳过重复，覆盖恢复前二次确认。
- **导出**：新版结构、旧版 `config.json`、Netscape Bookmark HTML（可导入浏览器）、CSV。
- **备份**：手动备份、定时备份（`scheduled` 入口 + Cron Trigger）、最近 30 份滚动保留、覆盖/合并恢复，恢复前自动创建 `pre-restore` 快照。
- **Cron 说明**：仓库默认不启用 `[triggers]`，避免配额限制导致部署失败。需要时在 `wrangler.toml` 加 `[triggers] crons = ["0 3 * * *"]`，或在 Cloudflare 控制台手动配置。
- **旧数据迁移**：旧版 `config.json` 可直接导入，自动兼容旧字段、按 `catelog` 补分类、补默认排序值。迁移流程：旧后台导出 → 部署新版本 → 初始化数据库 → 后台导入 → 检查首页/分类/标签。

## 📁 项目结构

```text
.
├── src/
│   ├── index.js                         # Worker 入口与路由分发
│   ├── handlers/                        # admin / api / go / pwa / siteLock 路由
│   ├── lib/                             # auth / favicon / i18n / utils / edgeCache
│   ├── pages/                           # 前台首页与后台 HTML/CSS/JS
│   └── services/                        # site / category / tag / backup / ai / webhook 等
├── extensions/browser-bookmark/         # Manifest V3 浏览器收藏插件
├── scripts/check-syntax.js              # JS 语法检查脚本
├── tests/                               # Node.js 内置测试用例
├── docs/                                # 文档索引、API/插件/部署/备份/WebHook 指南
├── schema.sql                           # D1 建表 SQL
├── wrangler.toml                        # Wrangler 配置
└── package.json
```

## 🗄️ 数据库结构

用 `schema.sql` 初始化 D1（命令见快速部署步骤 3）。核心表：

- `sites`：已发布书签，含 URL、Logo、描述、分类、可见性、排序、访问次数、健康检测信息。
- `pending_sites`：待审核书签（待审核/已通过/已拒绝 + 拒绝原因）。
- `categories`：父子分类、排序、图标、颜色、描述。
- `tags` / `site_tags`：标签与书签关联。
- `settings`：系统设置、AI 设置、私人书签等配置。
- `search_terms`：搜索词统计。
- `operation_logs`：操作审计与 WebHook 事件来源。
- `category_orders` / `category_metadata`：旧版兼容表。

KV `NAV_AUTH` 保存：管理员用户名与密码哈希、后台 Session、私人书签访问 token、API Token 元数据、WebHook 配置、备份快照。

## ⚙️ 系统设置

后台「系统设置」可配置网站名称、副标题、图标、页脚、系统公告和 AI 参数。图标同时影响前台/后台 favicon 与 PWA 显示，支持 `/pwa-icon.svg` 或完整 URL（自动补全协议）。

公告逻辑：启用且内容非空时前台弹窗；「我知道了」只关当前弹窗，「今日不再提示」写入 `localStorage` 当天不再弹；公告按版本区分，改版本会重置不再提示状态。

前后台同步刷新：后台通过 `localStorage` 广播刷新事件，前台监听 `storage` 事件自动刷新，无需 WebSocket。触发场景包括后台登录/退出、书签与分类增删改、审核、设置保存、导入成功。

## 🔐 管理员与权限

- 登录用 KV 中的管理员账号密码，成功后 Cookie 会话。
- 管理员在前台进入增强模式：直接编辑/删除书签、拖拽排序、直接查看私人书签。
- 普通访客访问私人书签分类需输入密码。
- 第三方写入用 Bearer Token，不依赖 Cookie；Token 管理、系统设置、AI 配置、备份恢复、操作日志、WebHook 等敏感接口仅接受管理员 Cookie。

## 📚 文档索引

- [docs/README.md](docs/README.md)：文档总索引。
- [docs/web-deployment-guide.md](docs/web-deployment-guide.md)：Cloudflare 网页版全流程部署教程。
- [docs/deployment-checklist.md](docs/deployment-checklist.md)：部署检查清单。
- [docs/api-guide.md](docs/api-guide.md)：API 开放与第三方接入指南。
- [docs/browser-extension-guide.md](docs/browser-extension-guide.md)：浏览器插件使用指南。
- [docs/webhook-guide.md](docs/webhook-guide.md)：WebHook 使用指南。
- [docs/backup-restore-guide.md](docs/backup-restore-guide.md)：备份、恢复与导入导出指南。
- [docs/phase-1-development-plan.md](docs/phase-1-development-plan.md)：第一阶段开发规划与巡查记录。
- [docs/phase-2-development-plan.md](docs/phase-2-development-plan.md)：第二阶段开发规划。

## 🛠️ 常用命令

```bash
npm install              # 安装依赖
npm run check            # JS 语法检查
npm test                 # 运行测试
npm run quality          # 语法检查 + 测试
npm run dev              # 本地开发
npx wrangler deploy --dry-run   # 部署预检查
npx wrangler deploy      # 部署
npx wrangler d1 execute homepage --file=schema.sql   # 执行数据库 SQL
```

## 🧪 工程质量与部署检查

- `npm run check` / `npm test` / `npm run quality`。
- `.github/workflows/quality.yml`：push / pull_request 时自动质量检查。
- `.github/workflows/deploy.yml`：push 到 main 自动部署。
- [docs/deployment-checklist.md](docs/deployment-checklist.md)：部署检查清单。

部署前执行 `npm run quality` 和 `npx wrangler deploy --dry-run`。启用自动健康巡检和定时备份前，确认 Cloudflare 账号 Cron Trigger 配额。

## ⬆️ 升级说明

从旧单文件版本升级（原项目通常只有 `worker.js` / `work_v1.js` / `work_v2.js`）：

1. 备份旧项目数据，旧后台导出 `config.json`。
2. 部署模块化版本，执行 `schema.sql` 初始化。
3. 配置 D1/KV 绑定与管理员账号。
4. 后台导入旧 `config.json`，检查书签、分类、标签、私人书签、系统设置。

已有 D1 数据库升级：执行 `schema.sql` 中对应的 `CREATE TABLE IF NOT EXISTS`、索引和兼容字段语句，确认 `sites`、`pending_sites`、`categories`、`settings` 存在。功能异常时优先核对表结构与 `schema.sql` 是否一致。

## 🔧 技术栈

- [Cloudflare Workers](https://workers.cloudflare.com/) + [D1](https://developers.cloudflare.com/d1/) + [KV](https://developers.cloudflare.com/workers/runtime-apis/kv/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- 原生 JavaScript、TailwindCSS CDN、HTML/CSS 模板字符串渲染

## 📝 更新日志

### 当前版本

- 新增系统设置服务，支持网站名称、副标题、图标、页脚和系统公告配置。
- 新增系统公告 Markdown 弹窗与「今日不再提示」，修复刷新闪现问题。
- 调整「我知道了」按钮逻辑：仅关闭当前弹窗，刷新后仍显示。
- 后台 favicon 与前台系统图标保持一致；修复后台生成脚本正则转义问题。
- 新增 AI 书签助理、私人书签访问控制、前台多布局与主题面板、提交分析、批量操作、链接健康检测、favicon 自动获取。
- 保留旧版数据导入导出兼容能力。

### 模块化重构版本

- 单文件 Worker 拆分为 `src/handlers`、`src/pages`、`src/services`、`src/lib`。
- 新增父子分类结构，后台支持分类改名、父分类、排序，前台层级缩进与展开/收起。
- 管理员前台直接拖拽排序，支持页面边缘自动滚动；书签描述悬停查看完整内容。
- 后台数据变更后前台跨标签页自动刷新。
- 保留访客提交审核与旧版 `config.json` 导入兼容。

## 📄 许可证

本项目沿用原项目许可证，详情见 [LICENSE](LICENSE)。
