import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  canAccessSite,
  canListSite,
  getAccessContext,
  isCacheableHomeRequest,
  isSiteLockAllowlisted,
  normalizeVisibility,
  visibilityWhere,
} from '../src/services/accessService.js';

function createMemoryKv(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, String(value)); },
    async delete(key) { store.delete(key); },
    async list(options = {}) {
      const prefix = options?.prefix || '';
      return {
        keys: [...store.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ name: key })),
        list_complete: true,
        cursor: '',
      };
    },
    _count() { return store.size; },
  };
}

function createMockEnv(kvSeed = {}) {
  return {
    NAV_AUTH: createMemoryKv(kvSeed),
    NAV_DB: { prepare() { throw new Error('NAV_DB should not be touched by access tests'); } },
  };
}

const ADMIN_TOKEN = 'admin-session-token';
const API_TOKEN = 'nav_test_read_secret';
const LOCK_TOKEN = 'lock-token';
const PRIVATE_TOKEN = 'private-token';

function seedAdminSession(env) {
  const now = Date.now();
  env.NAV_AUTH.put(`session:${ADMIN_TOKEN}`, JSON.stringify({ createdAt: now - 1000, lastRefresh: now - 1000 }));
}

function seedApiToken(env, { scopes = ['read'], token = API_TOKEN, id = 'test' } = {}) {
  env.NAV_AUTH.put(`api_token:${id}`, JSON.stringify({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    scopes,
  }));
}

function seedSiteLockState(env, enabled) {
  env.NAV_AUTH.put('site_lock:enabled', enabled ? '1' : '0');
}

function seedLockAccess(env, token = LOCK_TOKEN) {
  env.NAV_AUTH.put(`site-lock:access:${token}`, JSON.stringify({ createdAt: Date.now() - 1000, ttl: 43200 }));
}

function seedPrivateAccess(env, token = PRIVATE_TOKEN) {
  env.NAV_AUTH.put(`private-bookmarks:access:${token}`, JSON.stringify({ createdAt: Date.now() - 1000, ttl: 43200 }));
}

function makeRequest({ cookies = '', authorization = '' } = {}) {
  const headers = {};
  if (cookies) headers.Cookie = cookies;
  if (authorization) headers.Authorization = authorization;
  return new Request('https://nav.test/', { headers });
}

test('访问上下文：匿名请求全无凭据且可共享缓存', async () => {
  const env = createMockEnv();
  seedSiteLockState(env, false);
  const access = await getAccessContext(makeRequest(), env);
  assert.equal(access.adminAuthed, false);
  assert.equal(await access.siteLocked, false);
  assert.deepEqual(access.tokenScopes, []);
  assert.equal(access.privateUnlocked, false);
  assert.equal(await access.siteLocked, false);
  assert.equal(access.cacheAllowed, true);
});

test('访问上下文：管理员会话 cookie 全站放行且免锁', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  seedSiteLockState(env, true);
  const access = await getAccessContext(makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}` }), env);
  assert.equal(access.adminAuthed, true);
  assert.equal(access.privateUnlocked, true);
  assert.equal(access.cacheAllowed, false);
  assert.equal(await access.siteLocked, false); // 管理员会话可免锁访问全站
});

test('访问上下文：有效 Bearer Token 授予私人书签读取（ADR-0002）', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['read'] });
  const access = await getAccessContext(makeRequest({ authorization: `Bearer ${API_TOKEN}` }), env);
  assert.equal(access.tokenAuthenticated, true);
  assert.deepEqual(access.tokenScopes, ['read']);
  assert.equal(access.privateUnlocked, true);
});

test('访问上下文：弱 scope token 仍计 tokenAuthenticated——scope 校验留给 requireAdmin', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['read'] });
  const access = await getAccessContext(makeRequest({ authorization: `Bearer ${API_TOKEN}` }), env);
  assert.equal(access.tokenAuthenticated, true);
  assert.deepEqual(access.tokenScopes, ['read']); // 判定层不判权限，只交凭据
});

test('访问上下文：私人书签 cookie 解锁私密访问态', async () => {
  const env = createMockEnv();
  seedPrivateAccess(env);
  const access = await getAccessContext(makeRequest({ cookies: `nav_private_bookmarks_access=${PRIVATE_TOKEN}` }), env);
  assert.equal(access.privateUnlocked, true);
  assert.equal(access.browserPrivateUnlocked, true);
  assert.equal(access.adminAuthed, false);
  assert.equal(access.cacheAllowed, false);
});

test('访问上下文：整站锁启用且未解锁 → siteLocked', async () => {
  const env = createMockEnv();
  seedSiteLockState(env, true);
  const access = await getAccessContext(makeRequest(), env);
  assert.equal(await access.siteLocked, true);
});

test('访问上下文：整站锁启用 + 解锁 cookie → siteLocked=false', async () => {
  const env = createMockEnv();
  seedSiteLockState(env, true);
  seedLockAccess(env);
  const access = await getAccessContext(makeRequest({ cookies: `nav_site_lock=${LOCK_TOKEN}` }), env);
  assert.equal(await access.siteLocked, false);
});

test('访问上下文：Bearer Token 不授予页面语义（browserPrivateUnlocked）——仅 API 读接口', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['read'] });
  const access = await getAccessContext(makeRequest({ authorization: `Bearer ${API_TOKEN}` }), env);
  assert.equal(access.privateUnlocked, true); // ADR-0002：API 读接口语义
  assert.equal(access.browserPrivateUnlocked, false); // 页面路由（go/home）维持迁移前行为
  assert.equal(access.canAccess({ visibility: 'private', catelog: '私人' }), false);
});

test('访问上下文：admin 会话 + Bearer 同时存在时 token 独立校验（弱 token 暴露给 requireAdmin）', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  seedApiToken(env, { scopes: ['read'] });
  const access = await getAccessContext(
    makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}`, authorization: `Bearer ${API_TOKEN}` }),
    env,
  );
  assert.equal(access.adminAuthed, true);
  assert.equal(access.tokenAuthenticated, true); // 校验不因 admin 短路（requireAdmin 的 403 优先级依赖它）
  assert.deepEqual(access.tokenScopes, ['read']);
});

test('访问上下文：canAccess/canList 领域方法与布尔选项等价', async () => {
  const privateSite = { visibility: 'private', catelog: '私人' };
  const unlistedSite = { visibility: 'unlisted', catelog: '工具' };
  const adminOnlySite = { visibility: 'admin_only', catelog: '工具' };

  const anon = await getAccessContext(makeRequest(), createMockEnv());
  assert.equal(anon.canAccess(privateSite), false);
  assert.equal(anon.canAccess(unlistedSite), true);
  assert.equal(anon.canList(unlistedSite), false);
  assert.equal(anon.canAccess(adminOnlySite), false);
  // 与旧形态布尔选项完全等价
  assert.equal(anon.canAccess(privateSite), canAccessSite(privateSite, anon));
  assert.equal(anon.canList(unlistedSite), canListSite(unlistedSite, anon));

  const unlocked = await getAccessContext(
    makeRequest({ cookies: `nav_private_bookmarks_access=${PRIVATE_TOKEN}` }),
    createMockEnv({ 'private-bookmarks:access:private-token': '{}' }),
  );
  assert.equal(unlocked.canAccess(privateSite), true);
  assert.equal(unlocked.canList(privateSite), true);
});

test('isCacheableHomeRequest：任一鉴权 cookie 即不可共享缓存', () => {
  assert.equal(isCacheableHomeRequest(makeRequest()), true);
  assert.equal(isCacheableHomeRequest(makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}` })), false);
  assert.equal(isCacheableHomeRequest(makeRequest({ cookies: `nav_private_bookmarks_access=${PRIVATE_TOKEN}` })), false);
});

test('isCacheableHomeRequest：整站锁 cookie 必须拦截（硬约束，勿删）', () => {
  // 已解锁访客的个性化首页若进入共享缓存，会被未解锁访客命中——整站锁形同虚设。
  assert.equal(isCacheableHomeRequest(makeRequest({ cookies: `nav_site_lock=${LOCK_TOKEN}` })), false);
});

test('getAccessContext：同请求二次调用零新增 KV 读写（WeakMap 去重）', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  seedSiteLockState(env, false);
  const request = makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}` });
  const before = env.NAV_AUTH._count();
  await getAccessContext(request, env);
  await getAccessContext(request, env);
  assert.equal(env.NAV_AUTH._count(), before);
});

test('isSiteLockAllowlisted：白名单路由策略', () => {
  assert.equal(isSiteLockAllowlisted('/admin', 'GET'), true);
  assert.equal(isSiteLockAllowlisted('/admin', 'POST'), true);
  assert.equal(isSiteLockAllowlisted('/static/admin.js', 'GET'), true);
  assert.equal(isSiteLockAllowlisted('/api/settings/public', 'GET'), true);
  assert.equal(isSiteLockAllowlisted('/api/settings/public', 'POST'), false);
  assert.equal(isSiteLockAllowlisted('/api/sites', 'GET'), false);
  assert.equal(isSiteLockAllowlisted('/', 'GET'), false);
});

test('可见性规则：normalizeVisibility 与迁移前语义一致', () => {
  assert.equal(normalizeVisibility('PUBLIC'), 'public');
  assert.equal(normalizeVisibility('private'), 'private');
  assert.equal(normalizeVisibility('invalid', '私人书签'), 'private'); // 私密分类旧数据回退
  assert.equal(normalizeVisibility('invalid', '工具'), 'public'); // 其他非法值回退 public
  assert.equal(canAccessSite({ visibility: 'private', catelog: '私人' }, { privateUnlocked: true }), true);
  assert.equal(canListSite({ visibility: 'admin_only' }, { adminAuthed: true }), true);
});

test('visibilityWhere：admin 上下文返回空谓词（不过滤）', () => {
  const { sql, binds } = visibilityWhere({ adminAuthed: true, privateUnlocked: false });
  assert.equal(sql, '');
  assert.deepEqual(binds, []);
});

test('visibilityWhere：私人书签解锁返回 public+private 谓词、零绑定', () => {
  const { sql, binds } = visibilityWhere({ adminAuthed: false, privateUnlocked: true });
  assert.equal(sql, "COALESCE(s.visibility, 'public') IN ('public', 'private')");
  assert.deepEqual(binds, []);
});

test('visibilityWhere：匿名返回仅 public + 排除私密分类，绑定恰好一个', () => {
  const { sql, binds } = visibilityWhere({ adminAuthed: false, privateUnlocked: false });
  assert.equal(sql, "COALESCE(s.visibility, 'public') = 'public' AND COALESCE(c.name, s.catelog) <> ?");
  assert.equal(binds.length, 1);
  assert.equal(binds[0], '私人书签');
});

test('visibilityWhere：缺省与 null 上下文按匿名处理（接口级杜绝复漏）', () => {
  const absent = visibilityWhere();
  const nil = visibilityWhere(null);
  assert.equal(absent.sql, nil.sql);
  assert.deepEqual(absent.binds, nil.binds);
  assert.equal(absent.binds[0], '私人书签');
});
