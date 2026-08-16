import { normalizeDuplicateUrlKey } from './siteCore.js';
// 运行时迁移（runtime migration）：对「全新 D1（无 KV 标记）」或

// 「SCHEMA_MIGRATION_VERSION 升级」补跑幂等建表/加列/回填。
// 部署链路（GitHub Actions）每次 push 已执行幂等 schema.sql（wrangler d1 execute --file=schema.sql）；
// schema.sql 由 scripts/generate-schema.mjs 从本文件的单一源（TABLE_CREATE_SQL +
// 各表 *_ENSUREMENTS + *_INDEX_SQL）生成（2026-08-16 架构评审候选 7）——表/列/索引定义
// 只在此处维护，改完运行 npm run schema:generate 并提交产物；tests/migrationSchema.test.js
// 锁定「生成物 == 提交的 schema.sql」，防止手改单边漂移。
export const SCHEMA_MIGRATION_VERSION = '2';
const SCHEMA_MIGRATION_KV_KEY = 'schema_migration:version';

// ── 单一源：表定义（fresh schema 与运行时共用）──────────────────────
// comment 仅供生成 schema.sql 的文档注释，不参与运行时。
const TABLE_CREATE_SQL = [
  {
    table: 'spaces',
    comment: '空间表（支持多空间/多导航页）',
    sql: `
      CREATE TABLE IF NOT EXISTS spaces (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        icon TEXT,
        color TEXT,
        description TEXT,
        visibility TEXT NOT NULL DEFAULT 'public',
        sort_order INTEGER NOT NULL DEFAULT 9999,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    table: 'sites',
    comment: '网站配置表',
    sql: `
      CREATE TABLE IF NOT EXISTS sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        logo TEXT,
        desc TEXT,
        catelog TEXT NOT NULL,
        category_id INTEGER,
        space_id INTEGER,
        visibility TEXT NOT NULL DEFAULT 'public',
        sort_order INTEGER NOT NULL DEFAULT 9999,
        hits INTEGER DEFAULT 0,
        last_visit_time TIMESTAMP,
        last_checked_at TIMESTAMP,
        last_status_code INTEGER,
        last_error TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE SET NULL,
        FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )
    `,
  },
  {
    table: 'pending_sites',
    comment: '待审核网站表（审核中心：支持 pending/approved/rejected 状态）',
    sql: `
      CREATE TABLE IF NOT EXISTS pending_sites (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        logo TEXT,
        desc TEXT,
        catelog TEXT NOT NULL,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    table: 'settings',
    comment: '设置表',
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    table: 'categories',
    comment: '分类表（兼容旧 catelog 文本字段，支持父子分类与分类改名）',
    sql: `
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        parent_id INTEGER,
        space_id INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 9999,
        icon TEXT,
        color TEXT,
        description TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        update_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(parent_id) REFERENCES categories(id) ON DELETE SET NULL,
        FOREIGN KEY(space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )
    `,
  },
  {
    table: 'category_orders',
    comment: '分类排序表',
    sql: `
      CREATE TABLE IF NOT EXISTS category_orders (
        catelog TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL DEFAULT 9999
      )
    `,
  },
  {
    table: 'category_metadata',
    comment: '分类元数据表（旧版兼容保留）',
    sql: `
      CREATE TABLE IF NOT EXISTS category_metadata (
        catelog TEXT PRIMARY KEY,
        icon TEXT,
        description TEXT
      )
    `,
  },
  {
    table: 'search_terms',
    comment: '搜索关键词聚合统计表（仅记录关键词和结果数量，不保存用户身份信息）',
    sql: `
      CREATE TABLE IF NOT EXISTS search_terms (
        keyword TEXT PRIMARY KEY,
        total_searches INTEGER NOT NULL DEFAULT 0,
        total_results INTEGER NOT NULL DEFAULT 0,
        last_result_count INTEGER NOT NULL DEFAULT 0,
        zero_result_count INTEGER NOT NULL DEFAULT 0,
        first_searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_searched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    table: 'tags',
    comment: '标签表',
    sql: `
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  {
    table: 'site_tags',
    comment: '站点标签关联表',
    sql: `
      CREATE TABLE IF NOT EXISTS site_tags (
        site_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY(site_id, tag_id),
        FOREIGN KEY(site_id) REFERENCES sites(id) ON DELETE CASCADE,
        FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `,
  },
  {
    table: 'operation_logs',
    comment: '操作日志表（记录管理员关键写操作，用于追踪和审计）',
    sql: `
      CREATE TABLE IF NOT EXISTS operation_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL,
        target TEXT,
        target_id TEXT,
        summary TEXT,
        detail TEXT,
        ip TEXT,
        create_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
];

// 不依赖旧表新增字段的索引，随建表 batch 一并创建（仅创建于不存在时）。
const PRE_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name)',
  'CREATE INDEX IF NOT EXISTS idx_site_tags_tag ON site_tags(tag_id, site_id)',
  'CREATE INDEX IF NOT EXISTS idx_search_terms_total ON search_terms(total_searches DESC, last_searched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_search_terms_zero ON search_terms(zero_result_count DESC, last_searched_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_operation_logs_create_time ON operation_logs(create_time DESC, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_operation_logs_action ON operation_logs(action, create_time DESC)',
];

// ── 单一源：ensureColumn 清单（按表分组，顺序即运行时执行顺序）──────
// 生成器把未出现在 CREATE TABLE 的列并入 fresh schema（SQLite 列顺序不影响语义）。
const SPACES_ENSUREMENTS = [
  { column: 'name', definition: 'TEXT' },
  { column: 'slug', definition: 'TEXT' },
  { column: 'icon', definition: 'TEXT' },
  { column: 'color', definition: 'TEXT' },
  { column: 'description', definition: 'TEXT' },
  { column: 'visibility', definition: "TEXT NOT NULL DEFAULT 'public'" },
  { column: 'sort_order', definition: 'INTEGER NOT NULL DEFAULT 9999' },
  { column: 'create_time', definition: 'TIMESTAMP' },
  { column: 'update_time', definition: 'TIMESTAMP' },
];

const SITES_ENSUREMENTS = [
  { column: 'category_id', definition: 'INTEGER' },
  { column: 'space_id', definition: 'INTEGER' },
  { column: 'visibility', definition: "TEXT NOT NULL DEFAULT 'public'" },
  { column: 'sort_order', definition: 'INTEGER NOT NULL DEFAULT 9999' },
  { column: 'hits', definition: 'INTEGER DEFAULT 0' },
  { column: 'last_visit_time', definition: 'TIMESTAMP' },
  { column: 'last_checked_at', definition: 'TIMESTAMP' },
  { column: 'last_status_code', definition: 'INTEGER' },
  { column: 'last_error', definition: 'TEXT' },
  { column: 'create_time', definition: 'TIMESTAMP' },
  { column: 'update_time', definition: 'TIMESTAMP' },
  { column: 'url_key', definition: 'TEXT' },
  // 同步书签列（候选 7 补齐：此前仅 schema.sql 有，运行时建库漏列，idx 依赖其存在）
  { column: 'sync_source', definition: "TEXT NOT NULL DEFAULT 'manual'" },
  { column: 'browser_bookmark_id', definition: 'TEXT' },
];

const PENDING_ENSUREMENTS = [
  { column: 'tags', definition: 'TEXT' },
  { column: 'reason', definition: 'TEXT' },
  { column: 'status', definition: "TEXT NOT NULL DEFAULT 'pending'" },
  { column: 'reject_reason', definition: 'TEXT' },
  { column: 'reviewed_at', definition: 'TIMESTAMP' },
];

const CATEGORIES_ENSUREMENTS = [
  { column: 'parent_id', definition: 'INTEGER' },
  { column: 'space_id', definition: 'INTEGER' },
  { column: 'sort_order', definition: 'INTEGER NOT NULL DEFAULT 9999' },
  { column: 'icon', definition: 'TEXT' },
  { column: 'color', definition: 'TEXT' },
  { column: 'description', definition: 'TEXT' },
  { column: 'create_time', definition: 'TIMESTAMP' },
  { column: 'update_time', definition: 'TIMESTAMP' },
];

// 依赖 ensureColumn 新增字段的索引，必须在对应 ensure 之后创建（顺序敏感）。
const SITES_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_sites_catelog ON sites(catelog)',
  'CREATE INDEX IF NOT EXISTS idx_sites_sort ON sites(catelog, sort_order, create_time)',
  'CREATE INDEX IF NOT EXISTS idx_sites_category ON sites(category_id)',
  'CREATE INDEX IF NOT EXISTS idx_sites_space ON sites(space_id)',
  'CREATE INDEX IF NOT EXISTS idx_sites_url_key ON sites(url_key)',
  'CREATE INDEX IF NOT EXISTS idx_sites_sync_source ON sites(sync_source, browser_bookmark_id)',
];

const CATEGORIES_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_categories_parent ON categories(parent_id)',
  'CREATE INDEX IF NOT EXISTS idx_categories_space ON categories(space_id)',
  'CREATE INDEX IF NOT EXISTS idx_categories_sort ON categories(sort_order, name)',
];

// ── 模块级状态：单个 Worker isolate 生命周期内只迁移一次（或确认跳过）。
let migrationState = 'pending'; // pending | running | done
let migrationPromise = null;

// 仅供测试：重置模块级迁移状态，避免 node --test 用例间互相污染。
export function resetMigrationStateForTest() {
  migrationState = 'pending';
  migrationPromise = null;
}

export async function ensureSchema(env) {
  if (migrationState === 'done') return;
  if (migrationState === 'running') return migrationPromise;
  migrationState = 'running';
  migrationPromise = (async () => {
    try {
      const kv = env?.NAV_AUTH;
      const marker = kv?.get ? await kv.get(SCHEMA_MIGRATION_KV_KEY) : null;
      if (marker === SCHEMA_MIGRATION_VERSION) {
        migrationState = 'done';
        return;
      }
      await runMigration(env);
      if (kv?.put) await kv.put(SCHEMA_MIGRATION_KV_KEY, SCHEMA_MIGRATION_VERSION);
      migrationState = 'done';
    } catch (error) {
      migrationState = 'pending'; // 失败不缓存，下次请求重试
      migrationPromise = null;
      throw error;
    }
  })();
  return migrationPromise;
}

/**
 * 生成 fresh schema SQL（唯一事实源）：CREATE TABLE（并入本表 *_ENSUREMENTS 中
 * CREATE 未包含的列）+ 全部索引。供 scripts/generate-schema.mjs 产出 schema.sql，
 * 也被 tests/migrationSchema.test.js 用作「生成物 == 提交文件」的回归锁。
 * 纯函数，不触 env/D1。
 */
export function getFreshSchemaSql() {
  const ensureByTable = new Map([
    ['spaces', SPACES_ENSUREMENTS],
    ['sites', SITES_ENSUREMENTS],
    ['pending_sites', PENDING_ENSUREMENTS],
    ['categories', CATEGORIES_ENSUREMENTS],
  ]);

  const tableBlocks = TABLE_CREATE_SQL.map(({ table, comment, sql }) => {
    const bodyLines = sql
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(1, -1); // 去掉 CREATE TABLE ... ( 与收尾 )
    const fkLines = bodyLines.filter((line) => line.startsWith('FOREIGN KEY'));
    const columnLines = bodyLines.filter((line) => !line.startsWith('FOREIGN KEY'));
    const existingNames = new Set(columnLines.map((line) => line.split(/\s+/)[0]));

    // 只并入本表自己的 ensureColumn 清单（跨表同名列不得串表）
    const mergedColumns = [...columnLines];
    for (const { column, definition } of ensureByTable.get(table) || []) {
      if (!existingNames.has(column)) {
        mergedColumns.push(`${column} ${definition}`);
        existingNames.add(column);
      }
    }

    const columnBlocks = [...mergedColumns, ...fkLines];
    const lines = [
      `-- ${comment}`,
      `CREATE TABLE IF NOT EXISTS ${table} (`,
      ...columnBlocks.map((line, index) => `  ${line.replace(/,\s*$/, '')}${index === columnBlocks.length - 1 ? '' : ','}`),
      ');',
    ];
    return lines.join('\n');
  });

  const indexBlocks = [...PRE_INDEX_SQL, ...SITES_INDEX_SQL, ...CATEGORIES_INDEX_SQL]
    .map((sql) => `${sql};`);

  return [...tableBlocks, ...indexBlocks].join('\n\n');
}

async function runMigration(env) {
  console.log('[migration] ensuring all tables and indexes');

  await env.NAV_DB.batch([
    ...TABLE_CREATE_SQL.map(({ sql }) => env.NAV_DB.prepare(sql)),
    ...PRE_INDEX_SQL.map((sql) => env.NAV_DB.prepare(sql)),
  ]);

  for (const { column, definition } of SPACES_ENSUREMENTS) {
    await ensureColumn(env, 'spaces', column, definition);
  }
  await env.NAV_DB.prepare("UPDATE spaces SET visibility = 'public' WHERE visibility IS NULL OR TRIM(visibility) = ''").run();
  await env.NAV_DB.prepare("UPDATE spaces SET slug = 'default' WHERE (slug IS NULL OR TRIM(slug) = '') AND (name = '默认空间' OR name = 'Default' OR id = 1)").run();
  await env.NAV_DB.prepare("UPDATE spaces SET name = '默认空间' WHERE name IS NULL OR TRIM(name) = ''").run();

  for (const { column, definition } of SITES_ENSUREMENTS) {
    await ensureColumn(env, 'sites', column, definition);
  }
  for (const sql of SITES_INDEX_SQL) {
    await env.NAV_DB.prepare(sql).run();
  }
  await backfillSiteUrlKeys(env);

  for (const { column, definition } of PENDING_ENSUREMENTS) {
    await ensureColumn(env, 'pending_sites', column, definition);
  }
  await env.NAV_DB.prepare("UPDATE pending_sites SET status = 'pending' WHERE status IS NULL OR TRIM(status) = ''").run();

  for (const { column, definition } of CATEGORIES_ENSUREMENTS) {
    await ensureColumn(env, 'categories', column, definition);
  }
  for (const sql of CATEGORIES_INDEX_SQL) {
    await env.NAV_DB.prepare(sql).run();
  }
  await env.NAV_DB.prepare('UPDATE sites SET hits = 0 WHERE hits IS NULL').run();
  await env.NAV_DB.prepare("UPDATE sites SET visibility = 'public' WHERE visibility IS NULL OR TRIM(visibility) = ''").run();
  await env.NAV_DB.prepare("UPDATE sites SET visibility = 'private' WHERE catelog = '私人书签' AND visibility = 'public'").run();

  console.log('[migration] sync legacy catelog to categories');

  await env.NAV_DB.prepare(`
    INSERT OR IGNORE INTO categories (name, sort_order, icon, color, description)
    SELECT
      s.catelog AS name,
      COALESCE(co.sort_order, MIN(s.sort_order), 9999) AS sort_order,
      cm.icon,
      NULL AS color,
      cm.description
    FROM sites s
    LEFT JOIN category_orders co ON co.catelog = s.catelog
    LEFT JOIN category_metadata cm ON cm.catelog = s.catelog
    WHERE s.catelog IS NOT NULL AND TRIM(s.catelog) <> ''
    GROUP BY s.catelog
  `).run();

  await env.NAV_DB.prepare(`
    UPDATE categories
    SET sort_order = COALESCE(
      (SELECT sort_order FROM category_orders WHERE category_orders.catelog = categories.name),
      sort_order
    )
  `).run();

  await env.NAV_DB.prepare(`
    UPDATE sites
    SET category_id = (
      SELECT id FROM categories WHERE categories.name = sites.catelog
    )
    WHERE category_id IS NULL
      AND catelog IS NOT NULL
      AND TRIM(catelog) <> ''
      AND EXISTS (SELECT 1 FROM categories WHERE categories.name = sites.catelog)
  `).run();

  try {
    console.log('[migration] ensuring default space exists');
    let defaultSpace = await env.NAV_DB.prepare("SELECT id FROM spaces WHERE slug = 'default'").first();
    if (!defaultSpace) {
      const reusableSpace = await env.NAV_DB.prepare('SELECT id FROM spaces WHERE slug IS NULL OR TRIM(slug) = ? OR name = ? ORDER BY id ASC LIMIT 1').bind('', '默认空间').first();
      if (reusableSpace?.id) {
        console.log('[migration] repairing existing space as default space');
        await env.NAV_DB.prepare(`
          UPDATE spaces
          SET name = '默认空间',
              slug = 'default',
              description = COALESCE(description, '系统自动创建的默认导航空间'),
              visibility = COALESCE(NULLIF(TRIM(visibility), ''), 'public'),
              sort_order = 1,
              update_time = CURRENT_TIMESTAMP
          WHERE id = ?
        `).bind(reusableSpace.id).run();
      } else {
        console.log('[migration] creating default space');
        await env.NAV_DB.prepare(`
          INSERT INTO spaces (name, slug, description, visibility, sort_order)
          VALUES ('默认空间', 'default', '系统自动创建的默认导航空间', 'public', 1)
        `).run();
      }
      defaultSpace = await env.NAV_DB.prepare("SELECT id FROM spaces WHERE slug = 'default'").first();
    }
    if (defaultSpace && defaultSpace.id) {
      console.log(`[migration] default space ready (ID: ${defaultSpace.id})`);
    }
  } catch (error) {
    console.warn(`[migration] default space skipped: ${error?.message || error}`);
  }

  console.log('[migration] completed');
}

async function ensureColumn(env, tableName, columnName, definition) {
  const { results } = await env.NAV_DB.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = (results || []).some((column) => column.name === columnName);
  if (exists) return;

  console.log(`[migration] adding missing column ${tableName}.${columnName}`);
  await env.NAV_DB.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`).run();
}

// 回填 sites.url_key（仅处理空值行，幂等），供去重点查使用。
// 首次加列后会一次性回填全表，之后写路径自行维护，此处查到 0 行即跳过。
async function backfillSiteUrlKeys(env) {
  const { results } = await env.NAV_DB.prepare("SELECT id, url FROM sites WHERE url_key IS NULL OR url_key = ''").all();
  const rows = (results || [])
    .map((row) => ({ id: row.id, key: normalizeDuplicateUrlKey(row.url) }))
    .filter((row) => row.key);
  if (!rows.length) return;

  console.log(`[migration] backfilling url_key for ${rows.length} site(s)`);
  for (let i = 0; i < rows.length; i += 50) {
    const batchRows = rows.slice(i, i + 50);
    await env.NAV_DB.batch(
      batchRows.map((row) => env.NAV_DB.prepare('UPDATE sites SET url_key = ? WHERE id = ?').bind(row.key, row.id)),
    );
  }
}

