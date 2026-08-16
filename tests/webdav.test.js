// 备份生命周期（backupService）与 WebDAV 适配器（lib/webdav.js）测试
// ——2026-08-16 架构评审候选 2：传输/生命周期分离后两侧均可经内存 KV + mock D1 + mock fetch 直测；
// 此前 backupService 零测试，URL 拼接/鉴权头/上传失败语义无锁定。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBackup,
  deleteBackup,
  getBackupPayload,
  listBackups,
  restoreBackup,
} from '../src/services/backupService.js';
import {
  getWebDavBackupSettings,
  testWebDavBackupSettings,
  updateWebDavBackupSettings,
  uploadBackupToWebDav,
} from '../src/lib/webdav.js';

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

// settings 表（D1）+ NAV_AUTH KV 的最小面；all() 对站点/分类/标签查询一律返回空。
function createMockEnv({ settings = {} } = {}) {
  const settingStore = new Map(Object.entries(settings));
  const kv = createMemoryKv();
  return {
    NAV_AUTH: kv,
    NAV_DB: {
      prepare(sql) {
        const binds = [];
        return {
          bind(...args) {
            binds.push(...args);
            return this;
          },
          async first() {
            if (sql.includes('FROM settings WHERE key = ?')) {
              const value = settingStore.get(String(binds[0]));
              return value === undefined ? null : { value };
            }
            return null;
          },
          async all() {
            return { results: [] };
          },
          async run() {
            if (sql.includes('INSERT INTO settings') || sql.includes('ON CONFLICT(key)')) {
              settingStore.set(String(binds[0]), String(binds[1]));
            }
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
      async batch() {
        return [];
      },
    },
  };
}

test('getWebDavBackupSettings：缺省 enabled=false、path 回退 StarNav、密码不回传', async () => {
  const env = createMockEnv();
  const settings = await getWebDavBackupSettings(env);
  assert.equal(settings.enabled, 'false');
  assert.equal(settings.path, 'StarNav');
  assert.equal(settings.password, '');
  assert.equal(settings.hasPassword, false);
});

test("getWebDavBackupSettings：宽松布尔归一（'1'/'yes' 视为 true，单一源 lib/utils）", async () => {
  const env = createMockEnv({ settings: { 'backup.webdav.enabled': '1' } });
  assert.equal((await getWebDavBackupSettings(env)).enabled, 'true');
  const envYes = createMockEnv({ settings: { 'backup.webdav.enabled': 'yes' } });
  assert.equal((await getWebDavBackupSettings(envYes)).enabled, 'true');
});

test('updateWebDavBackupSettings：启用但缺 URL 拒绝；非 http(s) URL 拒绝；空密码保留原值', async () => {
  const env = createMockEnv();
  await assert.rejects(() => updateWebDavBackupSettings(env, { enabled: 'true', url: '' }), /URL is required/);
  await assert.rejects(() => updateWebDavBackupSettings(env, { enabled: 'true', url: 'ftp://x' }), /must start with http/);

  await updateWebDavBackupSettings(env, { enabled: 'true', url: 'https://dav.example.com', username: 'u', password: 'p', path: 'bk' });
  const updated = await getWebDavBackupSettings(env, { includePassword: true });
  assert.equal(updated.enabled, 'true');
  assert.equal(updated.url, 'https://dav.example.com');
  assert.equal(updated.username, 'u');
  assert.equal(updated.password, 'p', '密码应可解密回读');
  assert.equal(updated.path, 'bk');
});

test('uploadBackupToWebDav：未启用/未配置 URL 返回 skipped 不发起请求', async (t) => {
  const disabledEnv = createMockEnv();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  const skipped = await uploadBackupToWebDav(disabledEnv, { id: 'x' }, '{}');
  assert.equal(skipped.skipped, true);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('uploadBackupToWebDav：MKCOL 目录 + PUT 上传，鉴权头与目标 URL 正确', async (t) => {
  const env = createMockEnv({ settings: {
    'backup.webdav.enabled': 'true',
    'backup.webdav.url': 'https://dav.example.com/',
    'backup.webdav.username': 'u',
    'backup.webdav.password': 'enc:v1:test',
    'backup.webdav.path': 'StarNav /备份',
  } });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options.method, headers: options.headers });
    return new Response('', { status: 201 });
  });

  const result = await uploadBackupToWebDav(env, { id: '20260101_manual' }, '{"sites":[]}');

  assert.equal(result.uploaded, true);
  assert.ok(result.url.includes('/StarNav/%E5%A4%87%E4%BB%BD/'), '路径段应逐段 URL 编码（空格已 trim）');
  assert.ok(result.url.endsWith('20260101_manual.json'), '文件名应拼接在末尾');
  assert.equal(calls[0].method, 'MKCOL', '先建第一段目录');
  assert.equal(calls[1].method, 'MKCOL', '再建第二段目录');
  assert.equal(calls[2].method, 'PUT', '最后上传');
  assert.ok(calls[2].headers.Authorization?.startsWith('Basic '), '应带 Basic 鉴权头');
  assert.equal(calls[2].headers['Content-Type'], 'application/json; charset=utf-8');
});

test('uploadBackupToWebDav：HTTP 非 2xx 抛出带状态与响应体摘要的错误', async (t) => {
  const env = createMockEnv({ settings: {
    'backup.webdav.enabled': 'true',
    'backup.webdav.url': 'https://dav.example.com',
  } });
  t.mock.method(globalThis, 'fetch', async () => new Response('quota exceeded', { status: 507 }));
  await assert.rejects(() => uploadBackupToWebDav(env, { id: 'x' }, '{}'), /HTTP 507.*quota exceeded/);
});

test('testWebDavBackupSettings：PUT 探测成功 + DELETE 清理', async (t) => {
  const env = createMockEnv({ settings: {
    'backup.webdav.url': 'https://dav.example.com',
    'backup.webdav.path': 'bk',
  } });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(options.method);
    return new Response(null, { status: 204 });
  });
  const result = await testWebDavBackupSettings(env);
  assert.equal(result.ok, true);
  assert.equal(result.path, 'bk');
  assert.deepEqual(calls, ['MKCOL', 'PUT', 'DELETE'], '探测后应清理测试文件');
});

test('createBackup：KV 落快照与元数据，WebDAV 禁用时容错记录 skipped', async () => {
  const env = createMockEnv();
  const result = await createBackup(env, { reason: 'manual', note: '测试' });
  assert.equal(result.siteCount, 0);
  assert.equal(result.categoryCount, 0);
  assert.equal(result.webdav.skipped, true);

  const payload = await getBackupPayload(env, result.id);
  assert.ok(payload && Array.isArray(payload.sites), '快照载荷应可回读');
  const backups = await listBackups(env);
  assert.equal(backups.length, 1);
  assert.equal(backups[0].id, result.id);
  assert.equal(backups[0].note, '测试');
});

test('createBackup：WebDAV 上传失败不阻断本地备份（error 记录进 meta）', async (t) => {
  const env = createMockEnv({ settings: {
    'backup.webdav.enabled': 'true',
    'backup.webdav.url': 'https://dav.example.com',
  } });
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const result = await createBackup(env, { reason: 'manual' });
  assert.equal(result.webdav.uploaded, false);
  assert.match(result.webdav.error, /network down/);
});

test('createBackup：超过 MAX_BACKUPS 自动修剪到 30 份', async () => {
  const env = createMockEnv();
  for (let i = 0; i < 32; i += 1) {
    await createBackup(env, { reason: `m${i}` });
  }
  const backups = await listBackups(env);
  assert.equal(backups.length, 30, '修剪后保留 30 份');
});

test('deleteBackup / restoreBackup：删除清空 KV 双键；载荷缺失报错', async () => {
  const env = createMockEnv();
  const created = await createBackup(env, { reason: 'manual' });

  await assert.rejects(() => restoreBackup(env, 'no-such-id'), /Backup not found/);

  await deleteBackup(env, created.id);
  assert.equal(await getBackupPayload(env, created.id), null);
  assert.equal((await listBackups(env)).length, 0);
});
