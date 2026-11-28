/**
 * 网关凭据校验：门户已从「管理员账密」切换为「集成密钥」。
 * 文件名沿用历史（原测 OCTAFUSE_ADMIN_PASSWORD 强度），用例现在覆盖 OCTAFUSE_ADMIN_API_KEY。
 */
import { describe, expect, it } from 'vitest';
import { assertGatewayAdminApiKey, loadConfig } from '@/lib/config';

const KEY = 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
  OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
  OCTAFUSE_ADMIN_API_KEY: KEY,
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

describe('assertGatewayAdminApiKey', () => {
  it('拒绝 .env.example 与文档里的示例值', () => {
    for (const value of [
      'change-me',
      'please-change-this',
      'your-admin-api-key',
      'replace-me',
      'example-key',
      'sk-admin-0000000000000000',
    ]) {
      expect(() => assertGatewayAdminApiKey(value)).toThrow(/示例值/);
    }
  });

  it('拒绝过短密钥', () => {
    expect(() => assertGatewayAdminApiKey('ShortKey9f2c')).toThrow(/至少 16/);
  });

  it('拒绝字符种类过于单一的密钥', () => {
    expect(() => assertGatewayAdminApiKey('kkkkkkkkkkkkkkkkkkkkkkkk')).toThrow(/字符种类/);
  });

  it('放行随机密钥并去掉首尾空白', () => {
    expect(assertGatewayAdminApiKey(`  ${KEY}  `)).toBe(KEY);
  });

  it('报错文案指明去哪里创建 Key', () => {
    expect(() => assertGatewayAdminApiKey('change-me')).toThrow(/集成密钥/);
  });
});

describe('loadConfig 校验网关集成密钥', () => {
  it('缺少 OCTAFUSE_ADMIN_API_KEY 时启动即失败', () => {
    const { OCTAFUSE_ADMIN_API_KEY: _omitted, ...withoutKey } = baseEnv;
    expect(() => loadConfig(withoutKey)).toThrow(/OCTAFUSE_ADMIN_API_KEY/);
  });

  it('示例 Key 启动即失败', () => {
    expect(() => loadConfig({ ...baseEnv, OCTAFUSE_ADMIN_API_KEY: 'change-me' })).toThrow(
      /OCTAFUSE_ADMIN_API_KEY/
    );
  });

  it('合规 Key 正常加载', () => {
    const cfg = loadConfig(baseEnv);
    expect(cfg.octafuse.adminApiKey).toBe(KEY);
  });

  it('旧的 OCTAFUSE_ADMIN_USERNAME / OCTAFUSE_ADMIN_PASSWORD 不再被读取', () => {
    const cfg = loadConfig({
      ...baseEnv,
      OCTAFUSE_ADMIN_USERNAME: 'admin',
      OCTAFUSE_ADMIN_PASSWORD: 'legacy-password',
    });
    expect(cfg.octafuse).not.toHaveProperty('adminUsername');
    expect(cfg.octafuse).not.toHaveProperty('adminPassword');
    expect(cfg.octafuse.adminApiKey).toBe(KEY);
  });
});
