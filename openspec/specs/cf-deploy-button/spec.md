# CF Deploy Button

README 一键部署入口与 wrangler.toml 占位符兼容：`deploy.workers.cloudflare.com` 按钮、警示、收尾步骤、可回写的绑定占位符。

## Requirements

### Requirement: README 一键部署按钮

README 顶部 hero 区与「快速部署」章节开头 SHALL 各有一个一键部署按钮，使用 `deploy.workers.cloudflare.com` 标准模板，目标为 `https://deploy.workers.cloudflare.com/?url=https://github.com/javabcde/StarNav`。

#### Scenario: 顶部 hero 显示按钮
- **WHEN** 访客打开 README 标题区
- **THEN** 看到 Deploy to Cloudflare Workers 按钮，链接指向 `https://deploy.workers.cloudflare.com/?url=https://github.com/javabcde/StarNav`

#### Scenario: 快速部署章节显示按钮
- **WHEN** 访客滚动到「快速部署」章节开头
- **THEN** 看到同一按钮，位于两条现有部署路径之前

### Requirement: 警示与收尾步骤

按钮旁 SHALL 标注"按钮只创建初始项目，D1/KV 绑定与管理员账号需手动补齐"类警示；「快速部署」章节 SHALL 包含「一键部署路径」小节，列出收尾步骤：确认/创建 D1 并回写 `database_id`、创建 KV 命名空间并回写 id、执行 `schema.sql` 初始化、向 KV `NAV_AUTH` 写入 `admin_username`/`admin_password`，并链接 `docs/web-deployment-guide.md`。

#### Scenario: 新账号点按钮后按收尾步骤可完成部署
- **WHEN** 新账号通过按钮创建项目，按「一键部署路径」小节执行 4 步收尾
- **THEN** 得到可运行的 Worker（D1/KV 绑定存在、数据库已初始化、管理员可登录）

### Requirement: wrangler.toml 绑定占位符

`wrangler.toml` 的 D1 `database_id` 与 KV `id` SHALL 为占位符值（`REPLACE_WITH_YOUR_D1_DATABASE_ID` / `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`），保留 `database_name` 与 binding 名称；手动部署者 SHALL 在部署前替换为真实 ID。

#### Scenario: 占位符触发按钮流程创建资源
- **WHEN** 部署按钮流程读取 `wrangler.toml` 发现占位符 ID
- **THEN** 流程提供创建 D1/KV 的入口，并可将生成的 ID 回写到 fork 仓库

#### Scenario: 未替换占位符直接部署被拒绝
- **WHEN** 手动执行 `wrangler deploy` 且 `database_id`/KV `id` 仍为占位符
- **THEN** Wrangler 报错提示缺少真实 ID，部署失败

#### Scenario: 替换占位符后可正常部署
- **WHEN** 按 README 步骤 2/4 将真实 D1 `database_id` 与 KV id 填入 `wrangler.toml`
- **THEN** `wrangler deploy` 成功

### Requirement: 快速部署步骤提示占位符

README 快速部署步骤 2（创建 D1）与步骤 4（创建 KV）SHALL 注明当前 `wrangler.toml` 中为占位符、必须替换为生成的真实 ID。

#### Scenario: 部署者看到替换指引
- **WHEN** 部署者阅读快速部署步骤 2/4
- **THEN** 看到"当前为占位符 REPLACE_WITH_…，必须替换"的说明
