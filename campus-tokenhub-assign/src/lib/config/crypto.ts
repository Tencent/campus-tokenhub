/**
 * 配置值加解密。
 *
 * 敏感配置（腾讯云 AK/SK 等）不允许明文落库，这里统一走 AES-256-GCM：
 * - 密钥材料优先取 `CONFIG_ENCRYPTION_KEY`，缺省回退 `SESSION_SECRET`；
 * - 每个配置键用 HKDF 派生出独立密钥（salt 固定、info 为键名），
 *   这样即使某个键的密文泄漏也推导不出别的键；
 * - AAD 绑定键名，防止把 `tencent.secret_key` 的密文挪到 `tencent.secret_id` 列复用。
 *
 * 密文格式固定为 `v1:<base64(iv(12) | tag(16) | ciphertext)>`，为将来换算法留出版本位。
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';

export class ConfigCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigCryptoError';
  }
}

const VERSION = 'v1';
const PREFIX = `${VERSION}:`;
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_SALT = 'campus-tokenhub/config-v1';
/** 密钥材料下限：再短就没有实际强度，直接拒绝比默默用弱密钥安全 */
const MIN_MATERIAL_BYTES = 16;

/** 派生密钥缓存：键为「材料摘要 + 配置键名」，避免每次加解密都跑一遍 HKDF */
const derivedKeyCache = new Map<string, Buffer>();

function keyMaterial(): string {
  const explicit = (process.env.CONFIG_ENCRYPTION_KEY ?? '').trim();
  if (explicit) return explicit;

  const sessionSecret = (process.env.SESSION_SECRET ?? '').trim();
  if (sessionSecret) return sessionSecret;

  throw new ConfigCryptoError(
    '缺少配置加密密钥：请配置 CONFIG_ENCRYPTION_KEY，或确保 SESSION_SECRET 已设置'
  );
}

function deriveKey(configKey: string): Buffer {
  const material = keyMaterial();
  if (Buffer.byteLength(material, 'utf8') < MIN_MATERIAL_BYTES) {
    throw new ConfigCryptoError(
      `配置加密密钥材料不足 ${MIN_MATERIAL_BYTES} 字节：请配置更长的 CONFIG_ENCRYPTION_KEY 或 SESSION_SECRET`
    );
  }

  const materialHash = createHash('sha256').update(material).digest('hex').slice(0, 16);
  const cacheKey = `${materialHash}:${configKey}`;
  const cached = derivedKeyCache.get(cacheKey);
  if (cached) return cached;

  const derived = Buffer.from(
    hkdfSync('sha256', Buffer.from(material, 'utf8'), Buffer.from(HKDF_SALT, 'utf8'), Buffer.from(configKey, 'utf8'), KEY_LENGTH)
  );
  derivedKeyCache.set(cacheKey, derived);
  return derived;
}

/** 加密单个配置值；同一个明文每次都会得到不同密文（随机 IV）。 */
export function encryptConfigValue(plain: string, configKey: string): string {
  if (!configKey) throw new ConfigCryptoError('加密配置值时必须提供配置键名');

  const key = deriveKey(configKey);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(configKey, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/** 解密单个配置值；任何异常都转成不含密文内容的 ConfigCryptoError。 */
export function decryptConfigValue(payload: string, configKey: string): string {
  if (!configKey) throw new ConfigCryptoError('解密配置值时必须提供配置键名');
  if (typeof payload !== 'string' || !payload.startsWith(PREFIX)) {
    throw new ConfigCryptoError(`配置值格式不支持：缺少 ${PREFIX} 前缀（键 ${configKey}）`);
  }

  const body = Buffer.from(payload.slice(PREFIX.length), 'base64');
  if (body.length < IV_LENGTH + TAG_LENGTH) {
    throw new ConfigCryptoError(`配置值长度不足，无法解密（键 ${configKey}）`);
  }

  const key = deriveKey(configKey);
  const iv = body.subarray(0, IV_LENGTH);
  const tag = body.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = body.subarray(IV_LENGTH + TAG_LENGTH);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(configKey, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // 不把密文或明文带进错误信息：错误会被写进日志
    throw new ConfigCryptoError(`配置值解密失败，密钥可能已更换（键 ${configKey}）`);
  }
}

/** 仅测试用：清掉派生密钥缓存，便于切换密钥材料。 */
export function resetConfigCryptoCache(): void {
  derivedKeyCache.clear();
}
