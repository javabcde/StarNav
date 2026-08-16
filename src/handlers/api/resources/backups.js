import { errorResponse, jsonResponse } from '../../../lib/utils.js';
import { clientIpFromRequest } from '../../../services/operationLogService.js';
import { requireAdmin } from '../errors.js';
import { createBackup, deleteBackup, getBackupPayload, getWebDavBackupSettings, listBackups, restoreBackup, testWebDavBackupSettings, updateWebDavBackupSettings } from '../../../services/backupService.js';

/** GET /backups/webdav-settings — WebDAV 备份设置（管理员）。 */
export async function webdavSettingsGet(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await getWebDavBackupSettings(env);
  return jsonResponse({ code: 200, data });
}

/** PUT /backups/webdav-settings — 更新 WebDAV 设置（管理员）。 */
export async function webdavSettingsPut(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await updateWebDavBackupSettings(env, await request.json().catch(() => ({})));
  return jsonResponse({ code: 200, message: 'WebDAV backup settings updated successfully', data });
}

/** POST /backups/webdav-test — 测试 WebDAV 连接（管理员）。 */
export async function webdavTest(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await testWebDavBackupSettings(env, await request.json().catch(() => null));
  return jsonResponse({ code: 200, message: 'WebDAV backup test succeeded', data });
}

/** GET /backups — 备份列表（管理员）。 */
export async function list(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const data = await listBackups(env);
  return jsonResponse({ code: 200, data, total: data.length });
}

/** POST /backups — 创建备份（管理员；记录在服务层，含定时任务路径）。 */
export async function create(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const body = await request.json().catch(() => ({}));
  const meta = await createBackup(env, { reason: body?.reason || 'manual', note: body?.note, ip: clientIpFromRequest(request) });
  return jsonResponse({ code: 201, message: 'Backup created successfully', data: meta }, 201);
}

/** /backups/:id — POST restore / GET 下载 / DELETE（管理员；记录在服务层）。 */
export async function item(request, env, ctx, path, method, id, url) {
  if (path === '/backups') return null; // 集合路径非 GET/POST 不进门禁（与旧 404 行为一致）
  const unauthorized = await requireAdmin(request, env);
  if (unauthorized) return unauthorized;
  const backupId = decodeURIComponent(id);
  const isRestorePath = path === `/backups/${id}/restore` || path.endsWith('/restore');

  if (isRestorePath && method === 'POST') {
    const realId = decodeURIComponent(path.split('/')[2] || '');
    const body = await request.json().catch(() => ({}));
    const result = await restoreBackup(env, realId, { mode: body?.mode || 'overwrite', ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Backup restored successfully', data: result });
  }

  if (method === 'GET') {
    const payload = await getBackupPayload(env, backupId);
    if (!payload) return errorResponse('Backup not found', 404);
    return new Response(JSON.stringify(payload, null, 2), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="backup-${backupId}.json"`,
      },
    });
  }

  if (method === 'DELETE') {
    await deleteBackup(env, backupId, { ip: clientIpFromRequest(request) });
    return jsonResponse({ code: 200, message: 'Backup deleted successfully' });
  }

}
