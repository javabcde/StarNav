import { exportConfig, importSites } from './transferService.js';
import { uploadBackupToWebDav } from '../lib/webdav.js';
import { logOperation, OPERATION_LOG_ACTIONS } from './operationLogService.js';

// 备份生命周期（backup lifecycle）：KV 快照 + 元数据 + 保留策略 + 恢复。
// WebDAV 传输与设置 CRUD 已迁出为 lib/webdav.js 适配器（2026-08-16 架构评审候选 2），
// 本模块与传输只在 createBackup 一处交汇（失败容错不阻断本地备份）；
// boolString/limitText 等共享原语经 lib/utils 单一源消费（收编战役豁免区收口）。
const BACKUP_PREFIX = 'backup:';
const META_PREFIX = 'backup-meta:';
const MAX_BACKUPS = 30;

function buildBackupId(reason = 'manual', date = new Date()) {
  const iso = date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${iso}_${reason}`;
}

export async function listBackups(env) {
  if (!env?.NAV_AUTH) return [];
  const out = [];
  let cursor;
  do {
    const page = await env.NAV_AUTH.list({ prefix: META_PREFIX, cursor });
    for (const key of page.keys || []) {
      const raw = await env.NAV_AUTH.get(key.name);
      if (!raw) continue;
      try {
        const meta = JSON.parse(raw);
        out.push(meta);
      } catch {
        // skip corrupt entries
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out.sort((a, b) => String(b.id || '').localeCompare(String(a.id || '')));
}

async function pruneBackups(env, keep = MAX_BACKUPS) {
  const all = await listBackups(env);
  if (all.length <= keep) return { deleted: 0 };
  const toDelete = all.slice(keep);
  for (const meta of toDelete) {
    await Promise.all([
      env.NAV_AUTH.delete(`${BACKUP_PREFIX}${meta.id}`),
      env.NAV_AUTH.delete(`${META_PREFIX}${meta.id}`),
    ]);
  }
  return { deleted: toDelete.length };
}

export async function createBackup(env, { reason = 'manual', note = '', ip } = {}) {
  if (!env?.NAV_AUTH) throw new Error('Backup storage (NAV_AUTH KV) is not available');
  const config = await exportConfig(env);
  const payload = JSON.stringify(config);
  const sizeBytes = new TextEncoder().encode(payload).length;
  if (sizeBytes > 24 * 1024 * 1024) {
    throw new Error(`Backup size ${sizeBytes} bytes exceeds 24 MiB KV value limit`);
  }
  const id = buildBackupId(reason);
  const meta = {
    id,
    reason,
    note: String(note || '').slice(0, 200),
    createdAt: new Date().toISOString(),
    sizeBytes,
    siteCount: Array.isArray(config.sites) ? config.sites.length : 0,
    categoryCount: Array.isArray(config.categories) ? config.categories.length : 0,
  };
  await env.NAV_AUTH.put(`${BACKUP_PREFIX}${id}`, payload);

  try {
    const webdav = await uploadBackupToWebDav(env, meta, payload);
    meta.webdav = webdav;
  } catch (error) {
    meta.webdav = { uploaded: false, error: error?.message || 'WebDAV upload failed' };
    console.log(`[backup] webdav upload failed: ${meta.webdav.error}`);
  }

  await env.NAV_AUTH.put(`${META_PREFIX}${id}`, JSON.stringify(meta));
  const pruneResult = await pruneBackups(env, MAX_BACKUPS);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.BACKUP_CREATE, target: 'backup', targetId: meta.id, summary: `备份 ${meta.siteCount} 个书签 / ${meta.categoryCount} 个分类`, ip });
  return { ...meta, prunedOld: pruneResult.deleted };
}

export async function getBackupPayload(env, id) {
  if (!env?.NAV_AUTH) return null;
  const raw = await env.NAV_AUTH.get(`${BACKUP_PREFIX}${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteBackup(env, id, { ip } = {}) {
  if (!env?.NAV_AUTH) return { deleted: false };
  await Promise.all([
    env.NAV_AUTH.delete(`${BACKUP_PREFIX}${id}`),
    env.NAV_AUTH.delete(`${META_PREFIX}${id}`),
  ]);
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.BACKUP_DELETE, target: 'backup', targetId: id, ip });
  return { deleted: true, id };
}

export async function restoreBackup(env, id, { mode = 'overwrite', ip } = {}) {
  const payload = await getBackupPayload(env, id);
  if (!payload) throw new Error('Backup not found');
  // 恢复前自动创建一份"恢复前快照"，防止误操作丢数据
  let preRestoreSnapshot = null;
  try {
    preRestoreSnapshot = await createBackup(env, { reason: 'pre-restore', note: `before restore ${id}` });
  } catch (error) {
    console.log(`[backup] pre-restore snapshot failed: ${error?.message || error}`);
  }
  const restoreMode = mode === 'merge' ? 'merge' : 'overwrite';
  const importedSites = await importSites(env, payload, { mode: restoreMode });
  const result = {
    backupId: id,
    mode: restoreMode,
    importedSites,
    preRestoreSnapshotId: preRestoreSnapshot?.id || null,
  };
  await logOperation(env, { action: OPERATION_LOG_ACTIONS.BACKUP_RESTORE, target: 'backup', targetId: id, summary: `${restoreMode} 恢复 ${importedSites} 个书签`, ip });
  return result;
}

export async function runScheduledBackup(env) {
  if (!env?.NAV_AUTH) return { skipped: true, reason: 'KV not bound' };
  return createBackup(env, { reason: 'cron', note: 'scheduled backup' });
}