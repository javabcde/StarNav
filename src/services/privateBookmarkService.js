import { cleanText } from '../lib/utils.js';
import { getSettingRecord, setSetting } from './settingsService.js';
import { createUnlockSessionManager } from './unlockSessionService.js';

export const PRIVATE_BOOKMARK_CATEGORY = '私人书签';

export const PRIVATE_ACCESS_COOKIE_NAME = 'nav_private_bookmarks_access';
const PRIVATE_ACCESS_TOKEN_PREFIX = 'private-bookmarks:access:';
const PRIVATE_PASSWORD_SETTING_KEY = 'private_bookmarks_password';
const DEFAULT_PRIVATE_PASSWORD = '123456';

// 解锁会话机制实例（策略参数绑定本模块；导出面保持原样）。
// 密码 fallback：env 变量优先，其次内置默认密码（与历史行为一致）。
const unlockSession = createUnlockSessionManager({
  cookieName: PRIVATE_ACCESS_COOKIE_NAME,
  tokenPrefix: PRIVATE_ACCESS_TOKEN_PREFIX,
  settingKey: PRIVATE_PASSWORD_SETTING_KEY,
  passwordFallback: (env) => cleanText(
    env.PRIVATE_BOOKMARKS_PASSWORD ||
      env.PRIVATE_BOOKMARK_PASSWORD ||
      DEFAULT_PRIVATE_PASSWORD
  ),
});

export function isPrivateBookmarkCategory(catalog) {
  return cleanText(catalog) === PRIVATE_BOOKMARK_CATEGORY;
}
async function getPrivateBookmarkPasswordRecord(env) {
  const fallbackPassword = cleanText(
    env.PRIVATE_BOOKMARKS_PASSWORD ||
      env.PRIVATE_BOOKMARK_PASSWORD ||
      DEFAULT_PRIVATE_PASSWORD
  );
  const record = await getSettingRecord(env, PRIVATE_PASSWORD_SETTING_KEY, fallbackPassword);
  return { ...record, value: cleanText(record.value) };
}

export async function getPrivateBookmarkPassword(env) {
  return (await getPrivateBookmarkPasswordRecord(env)).value;
}

export async function updatePrivateBookmarkPassword(env, password) {
  const normalized = cleanText(password);
  if (!normalized) throw new Error('Private bookmark password is required');

  await setSetting(env, PRIVATE_PASSWORD_SETTING_KEY, await unlockSession.hashPassword(normalized));
  await unlockSession.clearAllTokens(env);
}

export async function clearPrivateBookmarkAccessTokens(env) {
  await unlockSession.clearAllTokens(env);
}

export const privateAccessDurationOptions = unlockSession.durationOptions;

export function normalizePrivateAccessDuration(value) {
  return unlockSession.normalizeDuration(value);
}

export function getPrivateAccessTtlSeconds(durationKey) {
  return unlockSession.getTtlSeconds(durationKey);
}

export async function createPrivateBookmarkAccess(env, { duration = '12h' } = {}) {
  return unlockSession.createAccess(env, { duration });
}

export function buildPrivateBookmarkAccessCookie(token, options = {}) {
  return unlockSession.buildCookie(token, options);
}

export function buildClearPrivateBookmarkAccessCookie() {
  return unlockSession.buildClearCookie();
}

export async function hasPrivateBookmarkAccess(request, env) {
  return unlockSession.hasAccess(request, env);
}

export async function revokeCurrentPrivateBookmarkAccess(request, env) {
  await unlockSession.revokeCurrent(request, env);
}

export async function verifyPrivateBookmarkPassword(env, password) {
  return unlockSession.verifyPassword(env, password);
}