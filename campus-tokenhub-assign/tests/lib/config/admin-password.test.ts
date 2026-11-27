import { describe, expect, it } from 'vitest';
import { assertGatewayAdminPassword, loadConfig } from '@/lib/config';

const STRONG = 'T3st-Gateway-Pass-9f2c';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
  OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: STRONG,
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

describe('assertGatewayAdminPassword', () => {
  it('拒绝 .env.example 与 compose 里的示例口令', () => {
    for (const value of ['change-me', 'octafuse123', 'OCTAFuse123', 'password', 'replace-me', 'admin']) {
      expect(() => assertGatewayAdminPassword(value)).toThrow(/示例口令/);
    }
  });

  it('拒绝过短口令', () => {
    expect(() => assertGatewayAdminPassword('Short-Pass-9f2c')).toThrow(/至少 16/);
  });

  it('拒绝字符种类过于单一的口令', () => {
    expect(() => assertGatewayAdminPassword('kkkkkkkkkkkkkkkkkkkkkkkk')).toThrow(/字符种类/);
  });

  it('拒绝与管理员用户名相同的口令', () => {
    expect(() => assertGatewayAdminPassword('Admin-Admin-Admin-1', 'Admin-Admin-Admin-1')).toThrow(/相同/);
  });

  it('放行随机口令并去掉首尾空白', () => {
    expect(assertGatewayAdminPassword(`  ${STRONG}  `)).toBe(STRONG);
  });

  it('报错文案给出生成命令', () => {
    expect(() => assertGatewayAdminPassword('change-me')).toThrow(/openssl rand -base64 24/);
  });
});

describe('loadConfig 校验网关管理员口令', () => {
  it('示例口令启动即失败', () => {
    expect(() => loadConfig({ ...baseEnv, OCTAFUSE_ADMIN_PASSWORD: 'octafuse123' })).toThrow(
      /OCTAFUSE_ADMIN_PASSWORD/
    );
  });

  it('合规口令正常启动', () => {
    const cfg = loadConfig({ ...baseEnv, OCTAFUSE_ADMIN_PASSWORD: STRONG });
    expect(cfg.octafuse.adminPassword).toBe(STRONG);
  });
});
