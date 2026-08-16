import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { getAccessContext } from '../src/services/accessService.js';
import {
  createPrivateBookmarkAccess,
  buildPrivateBookmarkAccessCookie,
} from '../src/services/privateBookmarkService.js';

function sha256Hex(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function createKvMock() {
  const kv = new Map();
  return {
    navAuth: {
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
      async list({ prefix }) {
        return {
          keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ name: k })),
          list_complete: true,
        };
      },
    },
    kv,
  };
}

function req(headers = {}) {
  return { headers: new Headers(headers) };
}

function seedApiToken(kv, { token, revoked = false } = {}) {
  const value = token || `test-token-${Math.random().toString(36).slice(2)}`;
  kv.set('api_token:key1', {
    value: JSON.stringify({
      id: 'key1',
      name: 'test',
      scopes: ['write'],
      tokenHash: sha256Hex(value),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: revoked ? new Date().toISOString() : null,
      expiresAt: null,
    }),
  });
  return value;
}

test('无凭据：privateAccess 为 false', async () => {
  const { navAuth } = createKvMock();
  const access = await getAccessContext(req(), { NAV_AUTH: navAuth });
  assert.equal(access.adminAuthed, false);
  assert.equal(access.tokenAuthenticated, false);
  assert.equal(access.privateUnlocked, false);
});

test('有效 Bearer Token：privateAccess 为 true（token 即密码级凭据）', async () => {
  const { navAuth, kv } = createKvMock();
  const token = seedApiToken(kv);
  const access = await getAccessContext(req({ Authorization: `Bearer ${token}` }), { NAV_AUTH: navAuth });
  assert.equal(access.tokenAuthenticated, true);
  assert.equal(access.privateUnlocked, true);
});

test('已吊销 Token：privateAccess 为 false', async () => {
  const { navAuth, kv } = createKvMock();
  const token = seedApiToken(kv, { revoked: true });
  const access = await getAccessContext(req({ Authorization: `Bearer ${token}` }), { NAV_AUTH: navAuth });
  assert.equal(access.tokenAuthenticated, false);
  assert.equal(access.privateUnlocked, false);
});

test('私人书签 Cookie：privateAccess 为 true', async () => {
  const { navAuth } = createKvMock();
  const created = await createPrivateBookmarkAccess({ NAV_AUTH: navAuth }, { duration: '1h' });
  const cookie = buildPrivateBookmarkAccessCookie(created.token, { maxAge: 3600 });
  const access = await getAccessContext(req({ Cookie: cookie }), { NAV_AUTH: navAuth });
  assert.equal(access.privateUnlocked, true);
  assert.equal(access.tokenAuthenticated, false);
});
