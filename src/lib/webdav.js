// WebDAV 传输（WebDAV Transport）：备份域 WebDAV 适配器——设置 CRUD + MKCOL/PUT/DELETE 传输。
// 2026-08-16 架构评审候选 2：从 backupService.js 迁出（传输与备份生命周期同住一文件、
// 仅 createBackup 一处交汇；且该模块是收编战役唯一漏网的 boolString/limitText 本地副本宿主）。
// 本模块 = 「设置 + 传输」完整适配器：配置是适配器自身状态，拆开会迫使两模块共享
// WEBDAV_PREFIX 与设置形状，反而制造第二处耦合。lib→services 边（settingsService 消费）
// 有 auth.js→unlockSessionService、edgeCache→accessService 先例（单一源消费）。
// 生命周期策略（list/prune/create/restore/scheduled）留在 backupService.js。
import { boolString, cleanText, limitText } from './utils.js';
import { getSetting, setSetting } from '../services/settingsService.js';
import { decryptSecret, encryptSecret } from './crypto.js';

const WEBDAV_PREFIX = 'backup.webdav.';

function encodePathSegment(segment) {
  return encodeURIComponent(segment).replace(/%2F/gi, '/');
}

function joinWebDavUrl(baseUrl, remotePath = '', fileName = '') {
  const base = limitText(baseUrl, 800).replace(/\/+$/g, '');
  const path = limitText(remotePath, 300)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((part) => encodePathSegment(part.trim()))
    .filter(Boolean)
    .join('/');
  const name = encodePathSegment(fileName);
  return [base, path, name].filter(Boolean).join('/');
}

function webDavAuthHeader(settings) {
  if (!settings.username && !settings.password) return {};
  return { Authorization: `Basic ${btoa(`${settings.username}:${settings.password}`)}` };
}

export async function getWebDavBackupSettings(env, { includePassword = false } = {}) {
  const settings = {
    enabled: boolString(await getSetting(env, `${WEBDAV_PREFIX}enabled`, 'false')),
    url: limitText(await getSetting(env, `${WEBDAV_PREFIX}url`, ''), 800),
    username: limitText(await getSetting(env, `${WEBDAV_PREFIX}username`, ''), 200),
    password: includePassword ? await decryptSecret(env, await getSetting(env, `${WEBDAV_PREFIX}password`, '')) : '',
    hasPassword: Boolean(await getSetting(env, `${WEBDAV_PREFIX}password`, '')),
    path: limitText(await getSetting(env, `${WEBDAV_PREFIX}path`, 'StarNav'), 300) || 'StarNav',
  };
  return settings;
}

export async function updateWebDavBackupSettings(env, payload = {}) {
  const current = await getWebDavBackupSettings(env, { includePassword: true });
  const next = {
    enabled: boolString(payload.enabled),
    url: limitText(payload.url, 800).replace(/\/+$/g, ''),
    username: limitText(payload.username, 200),
    password: payload.password === undefined || payload.password === null || payload.password === '' ? current.password : String(payload.password),
    path: limitText(payload.path, 300) || 'StarNav',
  };

  if (next.enabled === 'true' && !next.url) throw new Error('WebDAV URL is required when enabled');
  if (next.url && !/^https?:\/\//i.test(next.url)) throw new Error('WebDAV URL must start with http:// or https://');

  await setSetting(env, `${WEBDAV_PREFIX}enabled`, next.enabled);
  await setSetting(env, `${WEBDAV_PREFIX}url`, next.url);
  await setSetting(env, `${WEBDAV_PREFIX}username`, next.username);
  await setSetting(env, `${WEBDAV_PREFIX}password`, await encryptSecret(env, next.password));
  await setSetting(env, `${WEBDAV_PREFIX}path`, next.path);

  return getWebDavBackupSettings(env);
}

async function ensureWebDavDirectory(settings) {
  if (!settings.path) return;
  const parts = settings.path.replace(/^\/+|\/+$/g, '').split('/').map((part) => part.trim()).filter(Boolean);
  let currentPath = '';
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const dirUrl = joinWebDavUrl(settings.url, currentPath, '');
    await fetch(dirUrl, {
      method: 'MKCOL',
      signal: AbortSignal.timeout(15000),
      headers: webDavAuthHeader(settings),
    }).catch(() => null);
  }
}

export async function uploadBackupToWebDav(env, meta, payload) {
  const settings = await getWebDavBackupSettings(env, { includePassword: true });
  if (settings.enabled !== 'true') return { skipped: true, reason: 'WebDAV backup disabled' };
  if (!settings.url) return { skipped: true, reason: 'WebDAV URL not configured' };

  await ensureWebDavDirectory(settings);
  const fileName = `${meta.id}.json`;
  const targetUrl = joinWebDavUrl(settings.url, settings.path, fileName);
  const response = await fetch(targetUrl, {
    method: 'PUT',
    signal: AbortSignal.timeout(30000),
    headers: {
      ...webDavAuthHeader(settings),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: payload,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`WebDAV upload failed: HTTP ${response.status}${text ? ` ${text.slice(0, 120)}` : ''}`);
  }

  return { uploaded: true, url: targetUrl, fileName, status: response.status };
}

export async function testWebDavBackupSettings(env, payload = null) {
  const settings = payload ? {
    ...(await getWebDavBackupSettings(env, { includePassword: true })),
    enabled: boolString(payload.enabled, 'true'),
    url: limitText(payload.url, 800).replace(/\/+$/g, ''),
    username: limitText(payload.username, 200),
    password: payload.password ? String(payload.password) : (await getWebDavBackupSettings(env, { includePassword: true })).password,
    path: limitText(payload.path, 300) || 'StarNav',
  } : await getWebDavBackupSettings(env, { includePassword: true });

  if (!settings.url) throw new Error('WebDAV URL is required');
  if (!/^https?:\/\//i.test(settings.url)) throw new Error('WebDAV URL must start with http:// or https://');

  await ensureWebDavDirectory(settings);
  const fileName = `.starnav-test-${Date.now()}.txt`;
  const targetUrl = joinWebDavUrl(settings.url, settings.path, fileName);
  const put = await fetch(targetUrl, {
    method: 'PUT',
    signal: AbortSignal.timeout(15000),
    headers: {
      ...webDavAuthHeader(settings),
      'Content-Type': 'text/plain; charset=utf-8',
    },
    body: 'StarNav WebDAV backup test',
  });
  if (!put.ok) throw new Error(`WebDAV test upload failed: HTTP ${put.status}`);

  await fetch(targetUrl, { method: 'DELETE', signal: AbortSignal.timeout(10000), headers: webDavAuthHeader(settings) }).catch(() => null);
  return { ok: true, status: put.status, path: settings.path, fileName };
}
