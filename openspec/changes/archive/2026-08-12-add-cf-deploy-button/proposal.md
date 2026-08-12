## Why

StarNav 是 Cloudflare Workers 项目，但 README 缺少一键部署入口，访客/新账号部署要走完整的手动 Wrangler 流程。参照 Cloudflare-Navihive 的标准做法，在 README 加 `deploy.workers.cloudflare.com` 一键部署按钮，并让 `wrangler.toml` 与之兼容。

## What Changes

- README 顶部 hero 区（标题下方）与「快速部署」章节开头各加一个一键部署按钮，指向 `https://github.com/javabcde/StarNav`。
- 按钮旁加警示：按钮只创建初始项目，D1/KV 绑定与管理员账号仍需手动补齐（与 Navihive 同款提示）。
- 「快速部署」章节新增「一键部署路径」小节：点按钮后的收尾 4 步（确认/创建 D1 并把 `database_id` 写回 fork 的 `wrangler.toml`、创建 KV 命名空间并把 id 写回、执行 `schema.sql` 初始化、向 KV `NAV_AUTH` 写入 `admin_username`/`admin_password`），对齐现有 Wrangler 步骤 2–5，并链接 `docs/web-deployment-guide.md`。
- `wrangler.toml` 的 D1 `database_id` 与 KV `id` 从模板遗留值改为占位符（`REPLACE_WITH_...`），使部署按钮流程弹出资源创建对话框并可回写 ID；手动部署时按 README 步骤 2/4 填入真实 ID。
- 快速部署步骤 2/4 文案微调：提示当前为占位符、必须替换。

## Capabilities

### New Capabilities

- `cf-deploy-button`: README 一键部署入口与 wrangler.toml 占位符兼容（部署按钮、警示、收尾步骤、可回写的绑定占位符）。
