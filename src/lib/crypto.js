// 敏感配置（AI Key / WebDAV 密码 / WebHook secret）的对称加密。
//
// 主密钥取自 env.SECRET_KEY（建议用 `wrangler secret put SECRET_KEY` 配置）。
// 设计要点（向后兼容优先）：
//   - 未配置主密钥时，加密为 no-op（明文存储），与历史行为一致；
//   - 解密按 `enc:v1:` 前缀区分密文/明文，历史明文数据原样返回；
//   - 主密钥丢失/变更后，已加密数据将无法还原（解密返回空串）——需在文档中提示。

const ENC_PREFIX = 'enc:v1:';

let cachedKey = null;
let cachedSecretRef = null;

async function getKey(env) {
  const secret = env?.SECRET_KEY || env?.ENCRYPTION_KEY || '';
  if (!secret) return null;
  if (cachedKey && cachedSecretRef === secret) return cachedKey;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  cachedKey = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  cachedSecretRef = secret;
  return cachedKey;
}

// ── PBKDF2 密码哈希（解锁会话密码存储格式）────────────────────────
// 格式：pbkdf2$sha256$<iterations>$<salt-b64>$<hash-b64>（100k 迭代，PBKDF2-SHA256）。
// 使用者：siteLockService / privateBookmarkService（整站锁与私人书签密码）。
// 注意：auth.js 管理员密码是另一套 hex 双段格式（pbkdf2$<salt>$<hash>），
// 存储布局不兼容、不可混用——auth.js 保留自身实现，勿迁移到本段。
const PASSWORD_HASH_PREFIX = 'pbkdf2';
const PASSWORD_HASH_ITERATIONS = 100000;

export function timingSafeEqual(a, b) {
  const left = a instanceof Uint8Array ? a : new Uint8Array(a);
  const right = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

export function isHashedPassword(value) {
  return typeof value === 'string' && value.startsWith(`${PASSWORD_HASH_PREFIX}$`);
}

/**
 * PBKDF2-SHA256 哈希（解锁会话五段格式）。
 * @param {string} password 明文密码。
 * @param {Uint8Array} [salt] 16 字节盐，缺省随机生成。
 * @param {number} [iterations] 迭代次数，缺省 100k。
 * @returns {Promise<string>} `pbkdf2$sha256$<iter>$<salt-b64>$<hash-b64>`
 */
export async function hashPassword(password, salt = crypto.getRandomValues(new Uint8Array(16)), iterations = PASSWORD_HASH_ITERATIONS) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256
  );
  return `${PASSWORD_HASH_PREFIX}$sha256$${iterations}$${bytesToBase64(salt)}$${bytesToBase64(new Uint8Array(bits))}`;
}

/**
 * 校验 PBKDF2 哈希。格式不符或迭代数低于 10000 一律拒绝。
 * @param {string} password 明文密码。
 * @param {string} storedHash 存储的哈希串。
 * @returns {Promise<boolean>}
 */
export async function verifyPasswordHash(password, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 5 || parts[0] !== PASSWORD_HASH_PREFIX || parts[1] !== 'sha256') return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < 10000) return false;

  const salt = base64ToBytes(parts[3]);
  const expected = base64ToBytes(parts[4]);
  const nextHash = await hashPassword(password, salt, iterations);
  const actual = base64ToBytes(nextHash.split('$')[4]);
  return timingSafeEqual(actual, expected);
}

export function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/**
 * 加密敏感值。空值、已加密值原样返回；未配置主密钥时回退明文。
 *
 * @param {object} env Workers 环境绑定。
 * @param {string} plaintext 明文。
 * @returns {Promise<string>}
 */
export async function encryptSecret(env, plaintext) {
  const value = String(plaintext ?? '');
  if (!value || isEncrypted(value)) return value;
  const key = await getKey(env);
  if (!key) return value;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value));
  return `${ENC_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(buffer))}`;
}

/**
 * 解密敏感值。明文（无前缀）原样返回；缺主密钥或解密失败时返回空串。
 *
 * @param {object} env Workers 环境绑定。
 * @param {string} stored 存储值。
 * @returns {Promise<string>}
 */
export async function decryptSecret(env, stored) {
  const value = String(stored ?? '');
  if (!isEncrypted(value)) return value;
  const key = await getKey(env);
  if (!key) return '';
  const parts = value.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 2) return '';
  try {
    const buffer = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(parts[0]) },
      key,
      base64ToBytes(parts[1])
    );
    return new TextDecoder().decode(buffer);
  } catch {
    return '';
  }
}
