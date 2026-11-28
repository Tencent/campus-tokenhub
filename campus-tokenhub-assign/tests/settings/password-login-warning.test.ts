import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { PASSWORD_LOGIN_RISK_NOTICE, passwordLoginRiskNotice } from '@/lib/auth/local-admin';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
};

describe('passwordLoginRiskNotice', () => {
  it('auto 且凭据可用时给出风险提示', () => {
    const cfg = loadConfig({ ...baseEnv, PORTAL_ADMIN_LOGIN: 'auto' });

    expect(passwordLoginRiskNotice(cfg)).toBe(PASSWORD_LOGIN_RISK_NOTICE);
    expect(PASSWORD_LOGIN_RISK_NOTICE).toContain('绕过');
  });

  it('显式 off 时不提示（入口已关，没有风险可言）', () => {
    const cfg = loadConfig({ ...baseEnv, PORTAL_ADMIN_LOGIN: 'off' });

    expect(passwordLoginRiskNotice(cfg)).toBeNull();
  });

  it('未配置凭据时不提示', () => {
    const cfg = loadConfig({ ...baseEnv, PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' });

    expect(passwordLoginRiskNotice(cfg)).toBeNull();
  });

  it('显式 on 是运维的选择，不再劝', () => {
    const cfg = loadConfig({ ...baseEnv, PORTAL_ADMIN_LOGIN: 'on' });

    expect(passwordLoginRiskNotice(cfg)).toBeNull();
  });
});
