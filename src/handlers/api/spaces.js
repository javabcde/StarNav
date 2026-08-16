// 空间资源模块（spaces）：GET 公开读（按访问上下文过滤可见性）；
// POST/PUT/DELETE 为管理写——空间管理处于稳定化冻结期，过管理员门禁后一律 409。
import { jsonResponse } from '../../lib/utils.js';
import { getAccessContext } from '../../services/accessService.js';
import { listSpaces } from '../../services/spaceService.js';
import { requireAdmin } from './errors.js';

/** GET /spaces — 公开空间列表：admin 全量；admin_only 排除；private 需访问上下文 privateUnlocked（有效 Bearer Token 同样授予，见 ADR-0002）。 */
export async function handleGetSpaces(request, env, ctx, path, method, id, url) {
  const access = await getAccessContext(request, env);
  const allSpaces = await listSpaces(env);

  // 根据访问上下文过滤空间（API 读接口语义：token 亦解锁 private 空间）
  const filteredSpaces = allSpaces.filter((space) => {
    if (access.adminAuthed) return true;
    if (space.visibility === 'admin_only') return false;
    if (space.visibility === 'private') return access.privateUnlocked;
    return true;
  });

  return jsonResponse({ code: 200, data: filteredSpaces, total: filteredSpaces.length });
}

/** POST /spaces — 新增空间（冻结期：管理员 cookie-only 过门禁后统一 409）。 */
export async function handleSpacesCreate(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;

  return jsonResponse({
    code: 409,
    message: '空间管理功能当前处于稳定化冻结状态，暂不支持新增空间。',
  }, 409);
}

/** PUT /spaces/:id — 修改空间（冻结期：管理员 cookie-only 过门禁后统一 409）。 */
export async function handleSpacesUpdate(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;

  return jsonResponse({
    code: 409,
    message: '空间管理功能当前处于稳定化冻结状态，暂不支持修改空间。',
  }, 409);
}

/** DELETE /spaces/:id — 删除空间（冻结期：管理员 cookie-only 过门禁后统一 409）。 */
export async function handleSpacesDelete(request, env, ctx, path, method, id, url) {
  const unauthorized = await requireAdmin(request, env, { allowApiToken: false });
  if (unauthorized) return unauthorized;

  return jsonResponse({
    code: 409,
    message: '空间管理功能当前处于稳定化冻结状态，暂不支持删除空间。',
  }, 409);
}
