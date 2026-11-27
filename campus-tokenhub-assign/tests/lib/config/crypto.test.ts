import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigCryptoError,
  decryptConfigValue,
  encryptConfigValue,
  resetConfigCryptoCache,
} from '@/lib/config/crypto';

const BASE_ENV = { SESSION_SECRET: 'test-session-secret-value-32-chars-long' };

function withEnv(patch: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe('config crypto', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    resetConfigCryptoCache();
  });

  it('同一明文两次加密得到不同密文，但都能解回原值', () => {
    withEnv(BASE_ENV);
    const first = encryptConfigValue('secret-value', 'tencentSecretKey');
    const second = encryptConfigValue('secret-value', 'tencentSecretKey');

    expect(first).not.toBe(second);
    expect(decryptConfigValue(first, 'tencentSecretKey')).toBe('secret-value');
    expect(decryptConfigValue(second, 'tencentSecretKey')).toBe('secret-value');
  });

  it('密文格式为 v1:<base64>', () => {
    withEnv(BASE_ENV);
    const payload = encryptConfigValue('x', 'tencentSecretId');
    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload.slice(3)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('前缀缺失或版本未知时抛 ConfigCryptoError', () => {
    withEnv(BASE_ENV);
    expect(() => decryptConfigValue('not-encrypted', 'tencentSecretId')).toThrow(ConfigCryptoError);
    expect(() => decryptConfigValue('v2:AAAA', 'tencentSecretId')).toThrow(ConfigCryptoError);
  });

  it('用 A 键加密的密文拿到 B 键解密必须失败', () => {
    withEnv(BASE_ENV);
    const payload = encryptConfigValue('secret-value', 'tencentSecretKey');
    expect(() => decryptConfigValue(payload, 'tencentSecretId')).toThrow(ConfigCryptoError);
  });

  it('密文被篡改一个字节时解密失败，错误信息不含密文内容', () => {
    withEnv(BASE_ENV);
    const payload = encryptConfigValue('secret-value', 'tencentSecretKey');
    const body = payload.slice(3);
    const tampered = `${payload.slice(0, 3)}${body.slice(0, -2)}AA`;

    let message = '';
    try {
      decryptConfigValue(tampered, 'tencentSecretKey');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(tampered);
    expect(message).not.toContain('secret-value');
  });

  it('未配 CONFIG_ENCRYPTION_KEY 时从 SESSION_SECRET 派生，两条路径都能往返', () => {
    withEnv({ ...BASE_ENV, CONFIG_ENCRYPTION_KEY: undefined });
    const bySessionSecret = encryptConfigValue('value-a', 'logo');
    expect(decryptConfigValue(bySessionSecret, 'logo')).toBe('value-a');

    resetConfigCryptoCache();
    withEnv({ ...BASE_ENV, CONFIG_ENCRYPTION_KEY: 'independent-config-key-material' });
    const byConfigKey = encryptConfigValue('value-b', 'logo');
    expect(decryptConfigValue(byConfigKey, 'logo')).toBe('value-b');

    // 换密钥材料后旧密文不可解，防止「换了密钥还以为能读」
    expect(() => decryptConfigValue(bySessionSecret, 'logo')).toThrow(ConfigCryptoError);
  });

  it('密钥材料短于 16 字节时抛中文错误', () => {
    withEnv({ SESSION_SECRET: undefined, CONFIG_ENCRYPTION_KEY: 'short' });
    expect(() => encryptConfigValue('x', 'logo')).toThrow(/16/);
  });

  it('没有可用密钥材料时抛中文错误', () => {
    withEnv({ SESSION_SECRET: undefined, CONFIG_ENCRYPTION_KEY: undefined });
    expect(() => encryptConfigValue('x', 'logo')).toThrow(ConfigCryptoError);
  });
});
