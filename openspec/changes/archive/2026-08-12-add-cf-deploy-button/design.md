## Context

StarNav 仓库 `https://github.com/javabcde/StarNav`（remote 已确认）。README 现有 `## 🚀 快速部署`（第 214 行起），含「网页版全流程部署」与「Wrangler 部署」两条路径，Wrangler 路径步骤 1–7（安装依赖 → 建 D1 → 初始化 schema → 建 KV → 写管理员 KV → 质量检查 → deploy）。

已核实事实：
- 一键部署按钮标准模板（经 GitHub MCP 从 thusbs/Cloudflare-Navihive README 确认）：`[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<repo>)`。
- `wrangler.toml` 中 D1 `database_id`（c71211ff-…）与 KV `id`（3351cfb3-…）自初始同步提交 `efc1d2c` 起存在，为上游模板遗留值，不属于本账号资源（用户尚未部署过）。
- 管理员账号存 KV `NAV_AUTH` 的 `admin_username`/`admin_password`（`verifyAdminCredentials`），非环境变量，一键部署后需手动写入。
- 部署按钮流程只创建/连接初始 Worker 项目与可检测的绑定，不执行 `schema.sql`、不写管理员 KV。
- 本项目 schema：spec-driven；既有变更 `add-site-lock` 已归档提交。

## Goals / Non-Goals

**Goals:**
- README 顶部 hero 与「快速部署」章节各一个可点击的一键部署按钮，指向本仓库。
- 按钮旁警示 + 「一键部署路径」收尾步骤，让新账号部署不踩 D1/KV/管理员初始化坑。
- `wrangler.toml` 占位符化，使按钮流程可创建资源并回写 ID；手动部署提示清晰。

**Non-Goals:**
- 不改部署按钮之外的部署机制（Cron Trigger、WebHook、备份等配置仍走现有指南）。
- 不把管理员账号改为环境变量初始化。
- 不修改 `docs/web-deployment-guide.md` 现有内容（仅 README 引用它）。
- 不动 `add-site-lock` 变更产物。

## Decisions

1. **按钮指向 `javabcde/StarNav`**：`https://deploy.workers.cloudflare.com/?url=https://github.com/javabcde/StarNav`。备选（复制 Navihive 按钮原样链接他人仓库）拒绝——部署出来不是本项目。

2. **放置两处**：README 顶部 hero（标题/简介块之后、`## 🖼️ 界面预览` 之前）与「快速部署」章节开头。顶部保证可见性，章节内保证上下文。

3. **配套警示与收尾步骤**：按钮旁一行 ⚠️（按钮只创建初始项目，D1/KV 绑定与管理员账号需手动补齐）；「快速部署」章节在两条现有路径之前加「一键部署路径」小节，收尾 4 步对齐现有 Wrangler 步骤 2–5：
   1. 确认/创建 D1 数据库，把 `database_id` 写回按钮为你 fork 的仓库 `wrangler.toml`；
   2. 创建 KV 命名空间，把 namespace id 写回 fork 的 `wrangler.toml`（按钮流程通常不自动建 KV）；
   3. 执行 `npx wrangler d1 execute book --file=schema.sql --remote` 初始化；
   4. 向 KV `NAV_AUTH` 写入 `admin_username` / `admin_password`。
   并链接 `docs/web-deployment-guide.md`。

4. **`wrangler.toml` 占位符化**：`database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"`、KV `id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"`（保留 `database_name = "book"` 与 binding 名）。理由：模板遗留 ID 非本账号资源（git 历史核实 + 用户未部署过），占位符让按钮流程弹创建对话框并回写；手动部署时 README 步骤 2/4 本就要填真实 ID，占位符使"必须填"显式化。备选（保留遗留 ID）拒绝——新账号点按钮会拿到指向不存在资源的绑定而运行失败。

5. **快速部署步骤 2/4 文案微调**：注明当前为占位符、必须替换为真实 ID 后才能 `wrangler deploy`。

## Risks / Trade-offs

- **按钮流程对 KV 的支持不确定**：可能不弹 KV 创建对话框，故收尾步骤 2 显式写"创建 KV 命名空间并写回 id"，不依赖按钮自动完成。
- **占位符状态下 `wrangler deploy` 会失败**：这是期望的强制行为（提示替换 ID），非缺陷；README 步骤 2/4 已含替换指引。
- **`schema.sql` 与管理员 KV 必须手动**：按钮无法自动化，已用收尾步骤 + 警示覆盖。
- **README 顶部 hero 增加按钮**可能使截图预览区下移：轻微排版影响，接受。
