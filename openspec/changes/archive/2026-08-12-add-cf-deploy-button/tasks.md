## 1. wrangler.toml 占位符化

- [x] 1.1 `wrangler.toml`：D1 `database_id` 改为 `REPLACE_WITH_YOUR_D1_DATABASE_ID`，KV `id` 改为 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`（保留 `database_name = "book"` 与 binding 名）

## 2. README 部署按钮与配套说明

- [x] 2.1 README 顶部 hero：标题/简介块之后插入居中 Deploy to Cloudflare Workers 按钮（指向 `https://deploy.workers.cloudflare.com/?url=https://github.com/javabcde/StarNav`）
- [x] 2.2 「快速部署」章节开头插入同一按钮 + ⚠️ 警示（按钮只创建初始项目，D1/KV 绑定与管理员账号需手动补齐）
- [x] 2.3 「快速部署」章节新增「一键部署路径」小节：收尾 4 步（确认/创建 D1 并回写 `database_id` → 创建 KV 并回写 id → `schema.sql` 初始化 → 写 `admin_username`/`admin_password`），链接 `docs/web-deployment-guide.md`
- [x] 2.4 快速部署步骤 2/4 文案微调：注明当前为占位符、必须替换为真实 ID

## 3. 验证

- [x] 3.1 校验按钮 URL 与仓库 remote 一致；`wrangler.toml` 占位符替换后语法可用（tomllib 解析通过，占位符就位）
- [x] 3.2 `openspec-cn validate add-cf-deploy-button` 通过
