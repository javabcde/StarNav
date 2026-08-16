import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { requireAdmin } from '../src/handlers/api/errors.js';

function createMemoryKv() {
  const store = new Map();
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
  };
}

function createMockEnv() {
  return {
    NAV_AUTH: createMemoryKv(),
    NAV_DB: { prepare() { throw new Error('NAV_DB should not be touched by requireAdmin tests'); } },
  };
}

const ADMIN_TOKEN = 'admin-session-token';
const WRITE_TOKEN = 'nav_test_write_secret';
const READ_TOKEN = 'nav_test_read_secret';
const INVALID_TOKEN = 'nav_test_invalid_secret';

function seedAdminSession(env) {
  const now = Date.now();
  env.NAV_AUTH.put(`session:${ADMIN_TOKEN}`, JSON.stringify({ createdAt: now - 1000, lastRefresh: now - 1000 }));
}

function seedApiToken(env, { scopes = ['write'], token = WRITE_TOKEN, id = 'key1' } = {}) {
  env.NAV_AUTH.put(`api_token:${id}`, JSON.stringify({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    scopes,
  }));
}

function makeRequest({ cookies = '', authorization = '' } = {}) {
  const headers = {};
  if (cookies) headers.Cookie = cookies;
  if (authorization) headers.Authorization = authorization;
  return new Request('https://nav.test/api/sites', { method: 'POST', headers });
}

test('requireAdmin：无凭据且允许 token → 401（Admin cookie or Bearer token is required）', async () => {
  const env = createMockEnv();
  const result = await requireAdmin(makeRequest(), env, { allowApiToken: true, scope: 'write' });
  assert.equal(result.status, 401);
  const payload = await result.json();
  assert.equal(payload.error.code, 'UNAUTHORIZED');
  assert.equal(payload.error.message, 'Admin cookie or Bearer token is required');
});

test('requireAdmin：无凭据且不允许 token → 401（Admin authentication is required）', async () => {
  const env = createMockEnv();
  const result = await requireAdmin(makeRequest(), env, { allowApiToken: false });
  assert.equal(result.status, 401);
  const payload = await result.json();
  assert.equal(payload.error.message, 'Admin authentication is required');
});

test('requireAdmin：有效管理员会话 → 放行', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  const result = await requireAdmin(makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}` }), env);
  assert.equal(result, null);
});

test('requireAdmin：有效 token 且 scope 满足 → 放行', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['write'] });
  const result = await requireAdmin(makeRequest({ authorization: `Bearer ${WRITE_TOKEN}` }), env, { allowApiToken: true, scope: 'write' });
  assert.equal(result, null);
});

test('requireAdmin：弱 scope token → 403 且携带 requiredScope/tokenScopes', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['read'], token: READ_TOKEN });
  const result = await requireAdmin(makeRequest({ authorization: `Bearer ${READ_TOKEN}` }), env, { allowApiToken: true, scope: 'write' });
  assert.equal(result.status, 403);
  const payload = await result.json();
  assert.equal(payload.error.code, 'FORBIDDEN');
  assert.equal(payload.details.requiredScope, 'write');
  assert.deepEqual(payload.details.tokenScopes, ['read']);
});

test('requireAdmin：弱 token + 有效 admin cookie → 403（token 先于 admin 判定短路）', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  seedApiToken(env, { scopes: ['read'], token: READ_TOKEN });
  const result = await requireAdmin(
    makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}`, authorization: `Bearer ${READ_TOKEN}` }),
    env,
    { allowApiToken: true, scope: 'write' },
  );
  assert.equal(result.status, 403);
});

test('requireAdmin：无效 token + 有效 admin cookie → 放行（admin 兜底）', async () => {
  const env = createMockEnv();
  seedAdminSession(env);
  const result = await requireAdmin(
    makeRequest({ cookies: `nav_admin_session=${ADMIN_TOKEN}`, authorization: `Bearer ${INVALID_TOKEN}` }),
    env,
    { allowApiToken: true, scope: 'write' },
  );
  assert.equal(result, null);
});

test('requireAdmin：无效 token 且无 cookie → 401', async () => {
  const env = createMockEnv();
  const result = await requireAdmin(makeRequest({ authorization: `Bearer ${INVALID_TOKEN}` }), env, { allowApiToken: true, scope: 'write' });
  assert.equal(result.status, 401);
});

test('requireAdmin：不允许 token 时有效 token 不算数 → 401', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['write'] });
  const result = await requireAdmin(makeRequest({ authorization: `Bearer ${WRITE_TOKEN}` }), env, { allowApiToken: false });
  assert.equal(result.status, 401);
});

test('requireAdmin：admin scope 覆盖 write 要求', async () => {
  const env = createMockEnv();
  seedApiToken(env, { scopes: ['admin'] });
  const result = await requireAdmin(makeRequest({ authorization: `Bearer ${WRITE_TOKEN}` }), env, { allowApiToken: true, scope: 'write' });
  assert.equal(result, null);
});
