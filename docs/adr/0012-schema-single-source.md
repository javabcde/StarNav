# Schema 单一源：schema.sql 由 migrationService 生成

2026-08-16 架构评审（improve-codebase-architecture）候选 7 实施收口。同一份表/列定义此前在
schema.sql（CI 部署 + db:init）与 migrationService.runMigration（运行时幂等迁移）各手写一遍，
列清单还在 SITE_SELECT_COLUMNS 与 legacy 回退 SELECT 投影里再手写——加列要动四处，且两源已实际漂移：
schema.sql 含 `sites.sync_source/browser_bookmark_id` 与 `idx_sites_sync_source`，runMigration 缺；
runMigration 含 `idx_sites_category`，schema.sql 缺。运行时迁移内容零测试（migrationService.test.js
只测 KV 门闩），漂移无任何锁。

Status: accepted

## 决策要点

- **单一源**：migrationService.js 持有 `TABLE_CREATE_SQL`（11 张表，含文档注释）、按表分组的

  `*_ENSUREMENTS`（spaces/sites/pending_sites/categories，顺序即运行时执行顺序）、`PRE_INDEX_SQL`/
  `SITES_INDEX_SQL`/`CATEGORIES_INDEX_SQL`（15 条索引）。runMigration 消费同一数据，执行语义与
  顺序逐条保持（batch 建表+预索引 → 各组 ensureColumn → 依赖新列的索引 → 回填/数据修复）。
- **生成器** `scripts/generate-schema.mjs`（npm run schema:generate，build-css.mjs 同族代码生成）：
  从单一源渲染 fresh schema（CREATE TABLE 并入本表 ensurements 中 CREATE 未包含的列 + 全部索引），
  产出提交的 schema.sql。CI/deploy 路径不变（仍执行 schema.sql），但内容不再手写。
- **漂移修复**：sites 补 `sync_source`/`browser_bookmark_id` ensureColumn 与 `idx_sites_sync_source`
  （运行时建库此前漏列，同步书签查询依赖）；schema.sql 补 `idx_sites_category`。
  `SCHEMA_MIGRATION_VERSION` 1 → 2（定义变更强制存量 KV 标记重跑，幂等）；常量导出供测试消费。
- **回归锁** `tests/migrationSchema.test.js`：生成物与提交的 schema.sql 规范化相等（防手改单边漂移）
  + fresh schema 完整性（13 表、增列并入、15 索引）。存量 migrationService.test.js 的版本字面量
  改引导出常量（单一源，未来 bump 不再破测试）。

## Consequences

- **行为不变**：SQL 语句逐字搬迁，运行时执行顺序不变；生成 schema.sql 与旧文件语义等价
  （列顺序差异不改变 D1 行为；CI 部署幂等重跑无感）。
- **leverage**：加列/加索引只改 migrationService 一处，生成器自动同步 CI 面；测试锁死两源一致。
- **后续**：schema.sql 成为纯生成物，人工 review 只需看 migrationService.js；SITE_SELECT_COLUMNS
  与回退投影的列清单仍手写（候选范围外，留待列级测试基建就绪）。
