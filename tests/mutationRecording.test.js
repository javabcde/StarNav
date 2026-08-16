import test from 'node:test';
import assert from 'node:assert/strict';

// C6 变更记录服务化：写服务内部落 operation_logs（含 ip 可选上下文），
// handler 不再各自手写记录。测试断言记录 INSERT 的绑定顺序与内容。
import { createSite, deleteSite, updateSite } from '../src/services/siteService.js';
import { createCategory, deleteCategory } from '../src/services/categoryService.js';
import { deleteBackup } from '../src/services/backupService.js';
import { unsyncSite } from '../src/services/bookmarkSyncService.js';

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
    async list(options = {}) {
      const prefix = options.prefix || '';
      return {
        keys: Array.from(store.keys())
          .filter((name) => name.startsWith(prefix))
          .sort()
          .map((name) => ({ name })),
      };
    },
  };
}

function createMockEnv({ logBinds = [], existingSite = null, existingCategory = null } = {}) {
  const kv = createMemoryKv();
  return {
    NAV_AUTH: kv,
    NAV_DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return makeStatement(sql, binds);
          },
          all() {
            return makeStatement(sql, []).all();
          },
          first() {
            return makeStatement(sql, []).first();
          },
          run() {
            return makeStatement(sql, []).run();
          },
        };
      },
      async batch() {
        return [];
      },
    },
  };

  function makeStatement(sql, binds) {
    return {
      binds,
      async all() {
        return { results: [] };
      },
      async first() {
        if (/WHERE s\.id = \?/i.test(sql)) return existingSite;
        if (/FROM categories WHERE (?:id|name) = \?/i.test(sql)) return existingCategory;
        if (/SELECT sort_order FROM sites/i.test(sql)) return null;
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO operation_logs')) {
          logBinds.push(binds);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO sites')) {
          return { success: true, meta: { last_row_id: 42, changes: 1 } };
        }
        return { success: true, meta: { changes: 1 } };
      },
    };
  }
}

const BASE_SITE = { name: '示例站点', url: 'https://example.com', catelog: '工具' };

test('createSite：写库成功后记录 SITE_CREATE（targetId=新行 id、summary、ip 透传）', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds });
  const result = await createSite(env, BASE_SITE, { ip: '1.2.3.4' });

  assert.equal(result?.meta?.last_row_id, 42);
  assert.equal(logBinds.length, 1);
  const [action, target, targetId, summary, , ip] = logBinds[0];
  assert.equal(action, 'site.create');
  assert.equal(target, 'site');
  assert.equal(targetId, '42');
  assert.equal(summary, '示例站点');
  assert.equal(ip, '1.2.3.4');
});

test('updateSite：记录 SITE_UPDATE（targetId=站点 id）', async () => {
  const logBinds = [];
  const env = createMockEnv({
    logBinds,
    existingSite: { id: 7, name: '旧名', url: 'https://example.com', catelog: '工具', visibility: 'public', sort_order: 10, space_id: null },
  });
  await updateSite(env, 7, { name: '新名', url: 'https://example.com', catelog: '工具' }, { ip: '9.9.9.9' });

  assert.equal(logBinds.length, 1);
  const [action, target, targetId, summary] = logBinds[0];
  assert.equal(action, 'site.update');
  assert.equal(targetId, '7');
  assert.equal(summary, '新名');
});

test('deleteSite：记录 SITE_DELETE（无 summary、ip 可缺省）', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds });
  await deleteSite(env, 7);

  assert.equal(logBinds.length, 1);
  const [action, target, targetId] = logBinds[0];
  assert.equal(action, 'site.delete');
  assert.equal(target, 'site');
  assert.equal(targetId, '7');
});

test('createCategory：记录 CATEGORY_CREATE（summary=分类名）', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds });
  await createCategory(env, { name: '新分类' }, { ip: '1.1.1.1' });

  assert.equal(logBinds.length, 1);
  const [action, target, targetId, summary, , ip] = logBinds[0];
  assert.equal(action, 'category.create');
  assert.equal(summary, '新分类');
  assert.equal(ip, '1.1.1.1');
});

test('deleteCategory：记录 CATEGORY_DELETE（targetId=分类 id）', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds, existingCategory: { id: 3, name: '工具' } });
  await deleteCategory(env, 3);

  assert.equal(logBinds.length, 1);
  assert.equal(logBinds[0][0], 'category.delete');
  assert.equal(logBinds[0][2], '3');
});

test('deleteBackup：记录 BACKUP_DELETE（targetId=备份 id）', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds });
  const result = await deleteBackup(env, '20260816_manual', { ip: '2.2.2.2' });

  assert.equal(result.deleted, true);
  assert.equal(logBinds.length, 1);
  assert.equal(logBinds[0][0], 'backup.delete');
  assert.equal(logBinds[0][2], '20260816_manual');
});

test('unsyncSite：成功解除同步时记录 SYNC_BOOKMARK_UNSYNC，已手动/不存在不重复记录', async () => {
  const logBinds = [];
  const env = createMockEnv({ logBinds });
  const result = await unsyncSite(env, 5, { ip: '3.3.3.3' });

  assert.equal(result.changed, true);
  assert.equal(logBinds.length, 1);
  assert.equal(logBinds[0][0], 'sync.bookmark_unsync');
  assert.equal(logBinds[0][3], '解除书签同步');
});
