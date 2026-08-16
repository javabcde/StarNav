// 从 migrationService 单一源生成 schema.sql（架构评审候选 7，build-css.mjs 同族代码生成）。
// 用法：npm run schema:generate；改表/列/索引定义只改 src/services/migrationService.js，
// 运行本脚本后提交生成的 schema.sql；tests/migrationSchema.test.js 锁定两者一致。
import { readFileSync, writeFileSync } from 'node:fs';
import { getFreshSchemaSql } from '../src/services/migrationService.js';

const header = `-- 本文件由 scripts/generate-schema.mjs 从 src/services/migrationService.js 生成（唯一事实源）。
-- 修改表/列/索引定义请改 migrationService.js 后运行 npm run schema:generate，勿手改本文件。

`;

const output = `${header}${getFreshSchemaSql()}\n`;
const target = new URL('../schema.sql', import.meta.url);
const current = readFileSync(target, 'utf8');

if (current === output) {
  console.log('[schema:generate] schema.sql 已是最新，无需变更');
} else {
  writeFileSync(target, output);
  console.log('[schema:generate] schema.sql 已重新生成');
}
