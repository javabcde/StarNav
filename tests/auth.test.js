import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSessionCookie,
  clearLoginFailures,
  createAdminSession,
  getLoginThrottle,
  isAdminAuthenticated,
  validateAdminSession,
  verifyAdminCredentials,
} from '../src/lib/auth.js';
import { hashPassword as hashPasswordCanonical } from '../src/lib/crypto.js';
import { createIpThrottle } from '../src/lib/ipThrottle.js';
import {
  buildSessionCookie as buildPolicyCookie,
  shouldRenew,
} from '../src/lib/sessionPolicy.js';

function createMockEnv() {
  const kv = new Map();
  const navAuth = {
    async get(key) {
      const entry = kv.get(key);
      return entry ? entry.value : null;
    },
    async put(key, value, opts) {
      kv.set(key, { value, expirationTtl: opts?.expirationTtl });
    },
    async delete(key) {
      kv.delete(key);
    },
    async list() { return { keys: [], list_complete: true }; },
  };
  return { env: { NAV_DB: {}, NAV_AUTH: navAuth }, kv };
}

function req(cookie = '') {
  const headers = cookie ? { Cookie: cookie } : {};
  return new Request('https://x/', { headers });
}

test('admin 会话滑动续期降频：新鲜会话不写 KV，超半窗口才续并记 lastRefresh', async () => {
  const { env, kv } = createMockEnv();
  const token = await createAdminSession(env);
  const origPut = env.NAV_AUTH.put;
  let putCalls = 0;
  env.NAV_AUTH.put = async (...args) => { putCalls += 1; return origPut(...args); };

  // 刚登录：elapsed ≈ 0 < 6h → 不续期
  const { authenticated } = await validateAdminSession(req(`nav_admin_session=${token}`), env);
  assert.equal(authenticated, true);
  assert.equal(putCalls, 0, '新鲜会话不应触发续期写');

  // 伪造 7 小时前登录（无 lastRefresh）→ elapsed > 6h → 续期并写 lastRefresh
  const staleToken = 'stale-token';
  const stalePayload = JSON.stringify({ createdAt: Date.now() - 7 * 3600 * 1000 });
  await env.NAV_AUTH.put('session:stale-token', stalePayload, { expirationTtl: 12 * 3600 });
  putCalls = 0;
  assert.equal((await validateAdminSession(req('nav_admin_session=stale-token'), env)).authenticated, true);
  assert.equal(putCalls, 1, '超半窗口应续期一次');
  const stored = JSON.parse(kv.get('session:stale-token').value);
  assert.ok(Number.isFinite(stored.lastRefresh), '续期后应写入 lastRefresh');

  // lastRefresh 刚写 → 再校验不续
  putCalls = 0;
  await validateAdminSession(req('nav_admin_session=stale-token'), env);
  assert.equal(putCalls, 0, '距上次续期不足半窗口应跳过');
});

test('isAdminAuthenticated 同请求内去重：锁中间件与渲染只做 1 次 KV 读', async () => {
  const { env } = createMockEnv();
  const token = await createAdminSession(env);
  const request = req(`nav_admin_session=${token}`);

  const origGet = env.NAV_AUTH.get;
  let getCalls = 0;
  env.NAV_AUTH.get = async (...args) => { getCalls += 1; return origGet(...args); };

  const [a, b] = await Promise.all([isAdminAuthenticated(request, env), isAdminAuthenticated(request, env)]);
  await isAdminAuthenticated(request, env);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(getCalls, 1, '同一 Request 多次校验只应做一次 KV 读');

  // 不同 Request → 重新校验
  getCalls = 0;
  await isAdminAuthenticated(req(`nav_admin_session=${token}`), env);
  assert.equal(getCalls, 1, '不同请求不受缓存影响');
});

// ── 管理员密码验证三态（明文 → 旧 hex 双段 → 规范五段）─────────────────

// 旧 hex 双段格式的哈希段派生（历史 hashPassword 的复刻，仅测试构造旧存储用）
async function legacyHashPasswordHex(password, salt) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const derivedBits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: encoder.encode(salt), iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return Array.from(new Uint8Array(derivedBits), (b) => b.toString(16).padStart(2, '0')).join('');
}

test('管理员密码：明文命中自动升级为规范五段哈希，错误密码不升级', async () => {
  const { env, kv } = createMockEnv();
  await env.NAV_AUTH.put('admin_username', 'admin');
  await env.NAV_AUTH.put('admin_password', 'plain-pass');

  // 错误密码：登录失败且不得触发升级
  assert.equal(await verifyAdminCredentials(env, 'admin', 'wrong'), false);
  assert.equal(kv.get('admin_password').value, 'plain-pass', '错误密码不得触发升级');

  // 正确密码：命中并原地升级为规范五段格式（pbkdf2$sha256$100000$salt$hash）
  assert.equal(await verifyAdminCredentials(env, 'admin', 'plain-pass'), true);
  const upgraded = kv.get('admin_password').value;
  assert.equal(upgraded.split('$').length, 5, '升级后应为五段规范格式');
  assert.ok(upgraded.startsWith('pbkdf2$sha256$100000$'), '规范格式应带算法与迭代数段');
  assert.ok(!upgraded.includes('plain-pass'), '明文不得残留在存储中');

  // 升级后再登录：走规范校验路径，同样成功且值稳定（不重写）
  assert.equal(await verifyAdminCredentials(env, 'admin', 'plain-pass'), true);
  assert.equal(kv.get('admin_password').value, upgraded, '规范格式命中不重写');
});

test('管理员密码：旧 hex 双段哈希校验通过后原地升级为规范五段格式', async () => {
  const { env, kv } = createMockEnv();
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 历史 generateSalt 的 32 位 hex 盐形状
  const hash = await legacyHashPasswordHex('hex-pass', salt);
  const legacyValue = `pbkdf2$${salt}$${hash}`;
  await env.NAV_AUTH.put('admin_username', 'admin');
  await env.NAV_AUTH.put('admin_password', legacyValue);

  // 错误密码：不升级
  assert.equal(await verifyAdminCredentials(env, 'admin', 'wrong'), false);
  assert.equal(kv.get('admin_password').value, legacyValue, '错误密码不得触发升级');

  // 正确密码：旧 hex 算法校验通过，原地升级为规范五段格式（一次性写 KV）
  assert.equal(await verifyAdminCredentials(env, 'admin', 'hex-pass'), true);
  const upgraded = kv.get('admin_password').value;
  assert.equal(upgraded.split('$').length, 5, '升级后应为五段规范格式');
  assert.notEqual(upgraded, legacyValue, '升级必须改写存储值');

  // 升级后再登录：走规范校验路径成功，且值稳定
  assert.equal(await verifyAdminCredentials(env, 'admin', 'hex-pass'), true);
  assert.equal(kv.get('admin_password').value, upgraded, '规范路径命中不重写');
});

test('管理员密码：规范五段格式直接校验（新写入格式的验证路径）', async () => {
  const { env, kv } = createMockEnv();
  await env.NAV_AUTH.put('admin_username', 'admin');
  await env.NAV_AUTH.put('admin_password', await hashPasswordCanonical('modern-pass'));

  assert.equal(await verifyAdminCredentials(env, 'admin', 'modern-pass'), true);
  assert.equal(await verifyAdminCredentials(env, 'admin', 'wrong'), false);
  const stored = kv.get('admin_password').value;
  assert.equal(await verifyAdminCredentials(env, 'admin', 'modern-pass'), true);
  assert.equal(kv.get('admin_password').value, stored, '规范格式命中不重写');
});

test('管理员密码：畸形哈希值一律拒绝且不写 KV', async () => {
  const { env, kv } = createMockEnv();
  await env.NAV_AUTH.put('admin_username', 'admin');
  await env.NAV_AUTH.put('admin_password', 'pbkdf2$odd$segments');
  const before = kv.get('admin_password').value;

  assert.equal(await verifyAdminCredentials(env, 'admin', 'odd-segments'), false);
  assert.equal(kv.get('admin_password').value, before, '校验失败不得改写存储');
});

// ── IP 试错限速实例（lib/ipThrottle.js）───────────────────────────────

test('ipThrottle：IP 提取优先级、计数与 locked 边界、TTL 写入、损坏 payload 容错、clear', async () => {
  const { env, kv } = createMockEnv();
  const throttle = createIpThrottle({ prefix: 'test:throttle:', maxAttempts: 3, lockoutSeconds: 600 });

  // IP 提取：CF-Connecting-IP > X-Real-IP > 'unknown'
  const cfReq = new Request('https://x/', { headers: { 'CF-Connecting-IP': '9.9.9.9' } });
  assert.equal((await throttle.get(env, cfReq)).ip, '9.9.9.9');
  const realIpReq = new Request('https://x/', { headers: { 'X-Real-IP': '8.8.8.8' } });
  assert.equal((await throttle.get(env, realIpReq)).ip, '8.8.8.8');
  assert.equal((await throttle.get(env, new Request('https://x/'))).ip, 'unknown');

  // 计数从 0 开始；locked 边界：maxAttempts-1 未锁，maxAttempts 锁定
  let state = await throttle.get(env, cfReq);
  assert.equal(state.key, 'test:throttle:9.9.9.9');
  assert.equal(state.count, 0);
  assert.equal(state.locked, false);
  await throttle.register(env, state.key, state.count); // → 1
  await throttle.register(env, state.key, 1); // → 2（maxAttempts-1）
  state = await throttle.get(env, cfReq);
  assert.equal(state.count, 2);
  assert.equal(state.locked, false, 'count = maxAttempts-1 不锁定');
  await throttle.register(env, state.key, state.count); // → 3（maxAttempts）
  state = await throttle.get(env, cfReq);
  assert.equal(state.count, 3);
  assert.equal(state.locked, true, 'count = maxAttempts 锁定');

  // register 写入 TTL 与 payload 形状（{count, updatedAt} JSON）
  const entry = kv.get('test:throttle:9.9.9.9');
  assert.equal(entry.expirationTtl, 600, 'TTL 应为锁定窗口秒数');
  const payload = JSON.parse(entry.value);
  assert.equal(payload.count, 3);
  assert.ok(Number.isFinite(payload.updatedAt), 'payload 应带 updatedAt');

  // 损坏 payload 容错为 0
  await env.NAV_AUTH.put('test:throttle:2.2.2.2', 'not-json', {});
  const broken = await throttle.get(env, new Request('https://x/', { headers: { 'CF-Connecting-IP': '2.2.2.2' } }));
  assert.equal(broken.count, 0, '损坏 payload 容错为 0');
  assert.equal(broken.locked, false);

  // clear 清除计数；空 key 容错
  await throttle.clear(env, broken.key);
  assert.equal(
    (await throttle.get(env, new Request('https://x/', { headers: { 'CF-Connecting-IP': '2.2.2.2' } }))).count,
    0,
    'clear 后计数归零'
  );
  await throttle.clear(env, ''); // 空 key 不抛错
  assert.equal(throttle.maxAttempts, 3);
});

test('ipThrottle 前缀隔离：两个实例（登录 / 整站锁）计数互不干扰', async () => {
  const { env } = createMockEnv();
  const login = createIpThrottle({ prefix: 'login_fail:', maxAttempts: 5, lockoutSeconds: 900 });
  const siteLock = createIpThrottle({ prefix: 'site-lock:throttle:', maxAttempts: 5, lockoutSeconds: 900 });
  const request = new Request('https://x/', { headers: { 'CF-Connecting-IP': '1.2.3.4' } });

  // 登录侧失败 5 次 → 锁定；整站锁侧计数不受影响
  for (let i = 0; i < 5; i += 1) {
    const state = await login.get(env, request);
    await login.register(env, state.key, state.count);
  }
  assert.equal((await login.get(env, request)).locked, true);
  const other = await siteLock.get(env, request);
  assert.equal(other.count, 0, '不同前缀实例不得共享计数');
  assert.equal(other.locked, false);
  assert.ok(other.key.startsWith('site-lock:throttle:'), '整站锁实例应使用自己的前缀');

  // 后台登录导出面同样委托实例（key 前缀逐字保留）
  const exported = await getLoginThrottle(env, request);
  assert.ok(exported.key.startsWith('login_fail:'), '后台登录导出面保持 login_fail: 前缀');
  assert.equal(exported.locked, true, '后台登录计数已锁定');

  // clear 后重新计数
  await clearLoginFailures(env, exported.key);
  assert.equal((await getLoginThrottle(env, request)).count, 0, 'clear 后计数归零');
});

// ── 会话策略纯函数（lib/sessionPolicy.js）────────────────────────────

test('sessionPolicy.buildSessionCookie：属性集齐全、session 档无 Max-Age、清除语义 Max-Age=0', () => {
  const cookie = buildPolicyCookie('nav_x', 'tok', { maxAge: 3600, duration: '1h' });
  assert.ok(cookie.startsWith('nav_x=tok'));
  assert.ok(cookie.includes('Path=/'));
  assert.ok(cookie.includes('Max-Age=3600'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(!cookie.includes('Secure'), '不设 Secure（夸克/VIA 兼容）');

  const sessionCookie = buildPolicyCookie('nav_x', 'tok', { maxAge: 3600, duration: 'session' });
  assert.ok(!sessionCookie.includes('Max-Age'), 'session 档不写 Max-Age');

  const clearCookie = buildPolicyCookie('nav_x', '', { maxAge: 0 });
  assert.ok(clearCookie.includes('nav_x='));
  assert.ok(clearCookie.includes('Max-Age=0'), '清除语义 Max-Age=0');
});

test('sessionPolicy.shouldRenew：半窗边界、refreshedAt 锚点回落、锚点缺失保守续期', () => {
  const ttlMs = 12 * 3600 * 1000;
  const createdAt = 1000000;
  const half = createdAt + ttlMs / 2;

  // 恰好半窗：续期（>= 半窗即续）
  assert.equal(shouldRenew({ createdAt, ttlMs, now: half }), true, '恰好半窗应续期');
  // 剩余 > 半窗：跳过
  assert.equal(shouldRenew({ createdAt, ttlMs, now: half - 1 }), false, '不足半窗应跳过');
  // refreshedAt 优先作为锚点（管理员会话续期锚点）
  assert.equal(
    shouldRenew({ createdAt, refreshedAt: half - 1000, ttlMs, now: half }),
    false,
    '锚点应取 refreshedAt 而非 createdAt'
  );
  assert.equal(
    shouldRenew({ createdAt, refreshedAt: createdAt, ttlMs, now: half + 1 }),
    true,
    'refreshedAt 距今超半窗应续期'
  );
  // 锚点缺失（两者皆无）：保守续期
  assert.equal(shouldRenew({ createdAt: 0, ttlMs, now: 0 }), true, '锚点缺失应保守续期');
});

test('auth.buildSessionCookie：默认 Max-Age 为 12h，清除置 0，属性集同共享实现', () => {
  const cookie = buildSessionCookie('tok');
  assert.ok(cookie.startsWith('nav_admin_session=tok'));
  assert.ok(cookie.includes('Max-Age=43200'), '缺省 Max-Age 应为管理员会话 12h');
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('SameSite=Strict'));
  assert.ok(!cookie.includes('Secure'));
  assert.ok(buildSessionCookie('', { maxAge: 0 }).includes('Max-Age=0'));
});
