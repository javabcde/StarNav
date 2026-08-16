// 第三方 API Token 域（Bearer token）：创建 / 列表 / 吊销 / 校验 + 派生与脱敏。
// 2026-08-16 架构评审候选 6：从 auth.js 拆出——Token 自带 KV 布局（api_token: 前缀，
// 只存 sha256 哈希与脱敏元数据）与生命周期，与管理员会话/密码/限速三个子域无关。
// auth.js 保留 re-export 垫片保持存量测试与调用方 import 面（lib→lib，无方向违规）。
// 决策见 docs/adr/0007（候选 6）。
import { constantTimeCompare } from './crypto.js';

/**
 * @typedef {'read' | 'write' | 'admin' | string} ApiTokenScope
 */

/**
 * @typedef {object} ApiTokenPublicRecord
 * @property {string} id Token ID
 * @property {string} name Token 名称
 * @property {ApiTokenScope[]} scopes 授权范围
 * @property {string} createdAt 创建时间
 * @property {string|null} lastUsedAt 最近使用时间
 * @property {string|null} lastUsedIp 最近使用 IP
 * @property {number} useCount 使用次数（近似值，见校验处写频控）
 * @property {string|null} expiresAt 过期时间
 * @property {string|null} note 备注
 * @property {string|null} revokedAt 吊销时间
 */

const API_TOKEN_PREFIX = 'api_token:';
const API_TOKEN_SECRET_BYTES = 32;
const API_TOKEN_USAGE_WRITE_INTERVAL_MS = 60 * 1000; // Token 使用信息写 KV 的最小间隔，避免高频调用写放大

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

function generateApiTokenSecret() {
  const array = new Uint8Array(API_TOKEN_SECRET_BYTES);
  crypto.getRandomValues(array);
  return toHex(array);
}

async function sha256Hex(value) {
  const data = new TextEncoder().encode(String(value || ''));
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

function getBearerToken(request) {
  const authorization = request.headers.get('Authorization') || '';
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function hasBearerToken(request) {
  return Boolean(getBearerToken(request));
}

function normalizeTokenScopes(scopes = []) {
  const values = Array.isArray(scopes) ? scopes : String(scopes || '').split(/[,\s]+/);
  const normalized = values
    .map((scope) => String(scope || '').trim().toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(normalized.length ? normalized : ['read']));
}

function sanitizeApiTokenRecord(record = {}) {
  return {
    id: record.id,
    name: record.name || '未命名 Token',
    scopes: normalizeTokenScopes(record.scopes),
    createdAt: record.createdAt || null,
    lastUsedAt: record.lastUsedAt || null,
    lastUsedIp: record.lastUsedIp || null,
    useCount: record.useCount || 0,
    expiresAt: record.expiresAt || null,
    note: record.note || null,
    revokedAt: record.revokedAt || null,
  };
}

/**
 * 创建第三方 API Token。
 *
 * 返回值中的 `token` 只会在创建时明文返回一次；KV 中仅保存哈希和脱敏元数据。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {object} [input] Token 创建参数。
 * @param {string} [input.name] Token 名称。
 * @param {ApiTokenScope[]|string} [input.scopes] 授权范围，默认包含 `read` 和 `write`。
 * @param {string|null} [input.expiresAt] 过期时间。
 * @param {string} [input.note] 备注。
 * @returns {Promise<{token: string, data: ApiTokenPublicRecord}>}
 */
export async function createApiToken(env, input = {}) {
  const id = crypto.randomUUID();
  const secret = generateApiTokenSecret();
  const token = `nav_${id.replace(/-/g, '')}_${secret}`;
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const record = {
    id,
    name: String(input?.name || '第三方客户端').trim().slice(0, 80) || '第三方客户端',
    scopes: normalizeTokenScopes(input?.scopes || ['read', 'write']),
    tokenHash,
    createdAt: now,
    lastUsedAt: null,
    lastUsedIp: null,
    useCount: 0,
    expiresAt: input?.expiresAt || null,
    note: String(input?.note || '').trim().slice(0, 200) || null,
    revokedAt: null,
  };
  await env.NAV_AUTH.put(`${API_TOKEN_PREFIX}${id}`, JSON.stringify(record));
  return { token, data: sanitizeApiTokenRecord(record) };
}

/**
 * 列出所有 API Token 的脱敏元数据。
 *
 * 不返回 Token 明文或哈希，适合后台管理页展示。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @returns {Promise<ApiTokenPublicRecord[]>}
 */
export async function listApiTokens(env) {
  const list = await env.NAV_AUTH.list({ prefix: API_TOKEN_PREFIX });
  const records = [];
  for (const key of list.keys || []) {
    const raw = await env.NAV_AUTH.get(key.name);
    if (!raw) continue;
    try {
      records.push(sanitizeApiTokenRecord(JSON.parse(raw)));
    } catch {
      // ignore broken token metadata
    }
  }
  records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return records;
}

/**
 * 吊销指定 API Token。
 *
 * 吊销采用写入 `revokedAt` 的软删除方式，便于审计和保留历史记录。
 *
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {string} id Token ID。
 * @returns {Promise<ApiTokenPublicRecord>} 吊销后的脱敏 Token 记录。
 * @throws {Error} 当 ID 为空或 Token 不存在时抛出错误。
 */
export async function revokeApiToken(env, id) {
  const tokenId = String(id || '').trim();
  if (!tokenId) throw new Error('Token id is required');
  const key = `${API_TOKEN_PREFIX}${tokenId}`;
  const raw = await env.NAV_AUTH.get(key);
  if (!raw) throw new Error('Token not found');
  const record = JSON.parse(raw);
  record.revokedAt = record.revokedAt || new Date().toISOString();
  await env.NAV_AUTH.put(key, JSON.stringify(record));
  return sanitizeApiTokenRecord(record);
}

/**
 * 判断 token scope 数组是否满足所需权限。
 *
 * `admin` 覆盖一切；`write:sites` / `read:sites` 可满足对应 `write` / `read`；
 * 细粒度 `write:*` / `read:*` 要求由宽 scope 满足。空 requiredScope 表示任意 token 均可。
 *
 * @param {string[]} scopes token 的 scope 列表。
 * @param {ApiTokenScope|string} [requiredScope] 所需权限范围。
 * @returns {boolean}
 */
export function tokenHasScope(scopes, requiredScope) {
  if (!requiredScope) return true;
  if (scopes.includes('admin') || scopes.includes(requiredScope)) return true;
  if (requiredScope === 'write' && (scopes.includes('write:sites') || scopes.includes('write'))) return true;
  if (requiredScope === 'read' && (scopes.includes('read:sites') || scopes.includes('read'))) return true;
  if (requiredScope.startsWith('write:') && scopes.includes('write')) return true;
  if (requiredScope.startsWith('read:') && scopes.includes('read')) return true;
  return false;
}

/**
 * 校验请求中的 Bearer API Token。
 *
 * 会遍历 KV 中的 Token 哈希并使用常量时间比较；当 Token 存在但缺少所需 scope 时返回 `forbidden=true`。
 * 鉴权成功后会同步更新 `lastUsedAt`，确保后台管理页可可靠显示最近使用时间。
 *
 * @param {Request} request 当前请求。
 * @param {object} env Cloudflare Workers 环境绑定，需包含 `NAV_AUTH`。
 * @param {ApiTokenScope|string} [requiredScope='write'] 调用接口所需权限范围；`admin` scope 可覆盖普通权限。
 * @returns {Promise<AuthResult>}
 */
export async function validateApiToken(request, env, requiredScope = 'write') {
  const token = getBearerToken(request);
  if (!token) return { authenticated: false };
  const tokenHash = await sha256Hex(token);
  const list = await env.NAV_AUTH.list({ prefix: API_TOKEN_PREFIX });
  for (const key of list.keys || []) {
    const raw = await env.NAV_AUTH.get(key.name);
    if (!raw) continue;
    let record;
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (record?.revokedAt || !record?.tokenHash) continue;
    if (!(await constantTimeCompare(tokenHash, record.tokenHash))) continue;

    // 检查是否过期
    if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
      continue;
    }

    const scopes = normalizeTokenScopes(record.scopes);
    const hasPermission = tokenHasScope(scopes, requiredScope);

    if (requiredScope && !hasPermission) {
      return { authenticated: false, forbidden: true, token: sanitizeApiTokenRecord(record) };
    }

    // Token 鉴权成功后可靠写入最近使用时间、IP 和使用次数。
    // 这里不能使用未托管的后台 Promise，否则在 Cloudflare Workers 请求结束时可能被中止，
    // 导致管理页一直显示“从未使用”。
    // 为避免高频调用（尤其只读接口）每次都写 KV 造成写放大，
    // 仅在首次使用或距上次记录超过 API_TOKEN_USAGE_WRITE_INTERVAL_MS 时才持久化（useCount 因此为近似值）。
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Real-IP') || null;
    const now = Date.now();
    const lastUsedMs = record.lastUsedAt ? Date.parse(record.lastUsedAt) : 0;
    const updatePayload = {
      ...record,
      lastUsedAt: new Date(now).toISOString(),
      lastUsedIp: ip,
      useCount: (record.useCount || 0) + 1,
    };
    if (!lastUsedMs || now - lastUsedMs > API_TOKEN_USAGE_WRITE_INTERVAL_MS) {
      await env.NAV_AUTH.put(key.name, JSON.stringify(updatePayload));
    }

    return { authenticated: true, token: sanitizeApiTokenRecord(updatePayload) };
  }
  return { authenticated: false };
}
