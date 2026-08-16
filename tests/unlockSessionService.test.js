import test from 'node:test';
import assert from 'node:assert/strict';

import { createUnlockSessionManager, DEFAULT_DURATION, DEFAULT_TTL_OPTIONS } from '../src/services/unlockSessionService.js';

// 解锁会话核心单测（memory KV + settings mock，同仓库既有模式）。
// adapter 导出面（siteLockService / privateBookmarkService）由存量测试守护。

function createMemoryKv() {
  const map = new Map();
  const puts = new Map();
  return {
    get: async (key) => (map.has(key) ? map.get(key) : null),
    put: async (key, value) => {
      map.set(key, value);
      puts.set(key, (puts.get(key) || 0) + 1);
    },
    delete: async (key) => { map.delete(key); },
    list: async ({ prefix } = {}) => {
      const keys = [...map.keys()].filter((k) => k.startsWith(prefix || '')).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: null };
    },
    putCount: (key) => puts.get(key) || 0,
  };
}

function createMockEnv({ passwordSetting = null } = {}) {
  const settings = new Map();
  if (passwordSetting !== null) settings.set('test_password', passwordSetting);
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: {
      prepare(sql) {
        return {
          bind(...binds) {
            return createStatement(sql, binds);
          },
          all() {
            return createStatement(sql, []).all();
          },
          first() {
            return createStatement(sql, []).first();
          },
          run() {
            return createStatement(sql, []).run();
          },
        };
      },
    },
  };

  function createStatement(sql, binds) {
    return {
      async first() {
        if (sql.includes('FROM settings WHERE key = ?')) {
          const key = binds[0];
          if (settings.has(key)) return { value: settings.get(key) };
          return { value: null };
        }
        return null;
      },
      async run() {
        if (sql.includes('INSERT INTO settings') && sql.includes('ON CONFLICT')) {
          settings.set(binds[0], binds[1]);
        }
        return { success: true, meta: { changes: 1 } };
      },
      async all() {
        return { results: [] };
      },
      binds,
    };
  }
}

function makeRequest(cookie = '') {
  return { headers: new Headers(cookie ? { Cookie: cookie } : {}) };
}

const COOKIE = 'nav_test';
const PREFIX = 'test:access:';
const KEY = 'test_password';

function makeManager(overrides = {}) {
  return createUnlockSessionManager({
    cookieName: COOKIE,
    tokenPrefix: PREFIX,
    settingKey: KEY,
    ...overrides,
  });
}

test('时长词汇：五档顺序、默认档 12h 标记', () => {
  const manager = makeManager();
  assert.deepEqual(manager.durationOptions.map((o) => o.key), ['session', '1h', '12h', '7d', '30d']);
  const byKey = Object.fromEntries(manager.durationOptions.map((o) => [o.key, o]));
  assert.equal(byKey['12h'].default, true);
  assert.equal(byKey.session.default, undefined);
  assert.equal(byKey['1h'].label, '1 小时');
});

test('时长归一化：合法键保留、非法键回退 12h；TTL 换算正确', () => {
  const manager = makeManager();
  assert.equal(manager.normalizeDuration('1H'), '1h');
  assert.equal(manager.normalizeDuration(' 30d '), '30d');
  assert.equal(manager.normalizeDuration('forever'), DEFAULT_DURATION);
  assert.equal(manager.getTtlSeconds('1h'), 3600);
  assert.equal(manager.getTtlSeconds('12h'), DEFAULT_TTL_OPTIONS[DEFAULT_DURATION]);
  assert.equal(manager.getTtlSeconds('bogus'), DEFAULT_TTL_OPTIONS[DEFAULT_DURATION]);
});

test('createAccess：写 KV（前缀 + TTL 对应时长），返回 token/ttl/duration', async () => {
  const manager = makeManager();
  const env = createMockEnv();
  const access = await manager.createAccess(env, { duration: '1h' });
  assert.equal(access.duration, '1h');
  assert.equal(access.ttl, 3600);
  assert.ok(access.token);
  const payload = await env.NAV_AUTH.get(`${PREFIX}${access.token}`);
  const parsed = JSON.parse(payload);
  assert.equal(parsed.duration, '1h');
  assert.equal(parsed.ttl, 3600);
  assert.ok(Number.isFinite(Number(parsed.createdAt)));
});

test('hasAccess：无 cookie / 未知 token 为 false；有效 token 为 true', async () => {
  const manager = makeManager();
  const env = createMockEnv();
  assert.equal(await manager.hasAccess(makeRequest(), env), false);
  assert.equal(await manager.hasAccess(makeRequest(`${COOKIE}=unknown`), env), false);
  const { token } = await manager.createAccess(env, { duration: '12h' });
  assert.equal(await manager.hasAccess(makeRequest(`${COOKIE}=${token}`), env), true);
});

test('hasAccess：滑动续期——新鲜 token 不续期，剩余不足一半时写回', async () => {
  const manager = makeManager();
  const env = createMockEnv();
  const { token } = await manager.createAccess(env, { duration: '1h' });
  const sessionKey = `${PREFIX}${token}`;
  // 新鲜 token（剩余 > TTL/2）→ 不续期（createAccess 已写 1 次）
  assert.equal(await manager.hasAccess(makeRequest(`${COOKIE}=${token}`), env), true);
  assert.equal(env.NAV_AUTH.putCount(sessionKey), 1, '新鲜 token 不应触发续期写');
  // 陈旧 payload（createdAt 远早于现在 → 剩余 < TTL/2 → 必须续期写回）
  const stale = JSON.stringify({ createdAt: Date.now() - 2 * 3600 * 1000, duration: '1h', ttl: 3600 });
  await env.NAV_AUTH.put(sessionKey, stale);
  assert.equal(await manager.hasAccess(makeRequest(`${COOKIE}=${token}`), env), true);
  assert.equal(env.NAV_AUTH.putCount(sessionKey), 3, '剩余不足一半时必须写回续期（值不变、TTL 刷新）');
});

test('revokeCurrent：删除当前 cookie 对应 token；clearAllTokens：按前缀清空', async () => {
  const manager = makeManager();
  const env = createMockEnv();
  const a1 = await manager.createAccess(env);
  const a2 = await manager.createAccess(env);
  await manager.revokeCurrent(makeRequest(`${COOKIE}=${a1.token}`), env);
  assert.equal(await env.NAV_AUTH.get(`${PREFIX}${a1.token}`), null);
  assert.ok(await env.NAV_AUTH.get(`${PREFIX}${a2.token}`));
  await manager.clearAllTokens(env);
  assert.equal(await env.NAV_AUTH.get(`${PREFIX}${a2.token}`), null);
});

test('buildCookie：session 不写 Max-Age；其他时长写 Max-Age；clear cookie 置 0', () => {
  const manager = makeManager();
  const session = manager.buildCookie('tok', { maxAge: 3600, duration: 'session' });
  assert.ok(session.startsWith(`${COOKIE}=tok`));
  assert.ok(!session.includes('Max-Age'), 'session 档不得写 Max-Age');
  const twelve = manager.buildCookie('tok', { maxAge: 43200, duration: '12h' });
  assert.ok(twelve.includes('Max-Age=43200'));
  const clear = manager.buildClearCookie();
  assert.ok(clear.includes(`${COOKIE}=`));
  assert.ok(clear.includes('Max-Age=0'));
});

test('verifyPassword：哈希存储正确/错误密码；明文命中自动升级为哈希', async () => {
  const manager = makeManager();
  const env = createMockEnv({ passwordSetting: await manager.hashPassword('secret-123') });
  assert.equal(await manager.verifyPassword(env, 'secret-123'), true);
  assert.equal(await manager.verifyPassword(env, 'wrong'), false);

  const plainEnv = createMockEnv({ passwordSetting: 'plain-password' });
  assert.equal(await manager.verifyPassword(plainEnv, 'plain-password'), true);
  const record = await plainEnv.NAV_DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first();
  assert.equal(manager.isHashedPassword(record.value), true, '明文命中后必须自动升级为哈希');
  assert.equal(await manager.verifyPassword(plainEnv, 'plain-password'), true, '升级后仍可校验');
  assert.equal(await manager.verifyPassword(plainEnv, 'plain-password2'), false);
});

test('verifyPassword：空密码拒绝；passwordFallback 生效', async () => {
  const manager = makeManager({ passwordFallback: () => 'fallback-pass' });
  const env = createMockEnv(); // 无存储 → 用 fallback
  assert.equal(await manager.verifyPassword(env, 'fallback-pass'), true);
  assert.equal(await manager.verifyPassword(env, ''), false);
});

test('verifyPassword：requireEnabledCheck 时 enabledCheck 为假一律拒绝', async () => {
  let enabled = false;
  const manager = makeManager({
    requireEnabledCheck: true,
  });
  const env = createMockEnv({ passwordSetting: await manager.hashPassword('secret-123') });
  assert.equal(await manager.verifyPassword(env, 'secret-123', { enabledCheck: () => enabled }), false);
  enabled = true;
  assert.equal(await manager.verifyPassword(env, 'secret-123', { enabledCheck: () => enabled }), true);
});

test('verifyPassword：脏数据边界——外部直写带首尾空白的明文同样接受并升级', async () => {
  const manager = makeManager();
  const env = createMockEnv({ passwordSetting: ' padded-pass ' });
  assert.equal(await manager.verifyPassword(env, 'padded-pass'), true);
  const record = await env.NAV_DB.prepare('SELECT value FROM settings WHERE key = ?').bind(KEY).first();
  assert.equal(manager.isHashedPassword(record.value), true, '带空白明文命中后必须升级为哈希');
  assert.equal(await manager.verifyPassword(env, 'padded-pass'), true, '升级后仍可校验');
});
