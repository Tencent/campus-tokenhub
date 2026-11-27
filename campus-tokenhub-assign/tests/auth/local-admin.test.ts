import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@/lib/config';
import { READY_OAUTH2, withOauth2 } from '../helpers/auth-config';
import {
  canUsePasswordLogin,
  isLocalAdminSub,
  isPasswordSessionAllowed,
  localAdminIdentity,
  passwordLoginState,
  verifyLocalAdminCredentials,
} from '@/lib/auth/local-admin';

const BASE_ENV: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'gateway-admin',
  OCTAFUSE_ADMIN_PASSWORD: 'gateway-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'local-admin-test-session-secret-32-chars',
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
};

function cfg(extra: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...BASE_ENV, ...extra });
}

/** SSO 五项齐全：等价于「设置页已配好」，用 config 覆盖而不是 env */
function ssoReady(extra: Record<string, string> = {}): AppConfig {
  return withOauth2(cfg(extra), READY_OAUTH2);
}

describe('passwordLoginState（关闭判据）', () => {
  it('未配置凭据 → unconfigured', () => {
    expect(
      passwordLoginState(
        loadConfig({ ...BASE_ENV, PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' })
      )
    ).toBe('unconfigured');
  });

  it('凭据齐全且 SSO 未配齐 → available', () => {
    expect(passwordLoginState(cfg())).toBe('available');
  });

  it('凭据齐全且 SSO 已配齐 → 仍 available（不再自动关闭，交运维手动 off）', () => {
    expect(passwordLoginState(ssoReady())).toBe('available');
  });

  it('PORTAL_ADMIN_LOGIN=off 时无论 SSO 是否配齐都关闭', () => {
    expect(passwordLoginState(cfg({ PORTAL_ADMIN_LOGIN: 'off' }))).toBe('disabled_by_switch');
    expect(passwordLoginState(ssoReady({ PORTAL_ADMIN_LOGIN: 'off' }))).toBe(
      'disabled_by_switch'
    );
  });

  it('PORTAL_ADMIN_LOGIN=on 时无视 SSO 状态（救急通道）', () => {
    expect(passwordLoginState(ssoReady({ PORTAL_ADMIN_LOGIN: 'on' }))).toBe('available');
  });

  it('canUsePasswordLogin 只在 available 时为真（SSO 配齐也算 available）', () => {
    expect(canUsePasswordLogin(cfg())).toBe(true);
    expect(canUsePasswordLogin(ssoReady())).toBe(true);
    expect(canUsePasswordLogin(cfg({ PORTAL_ADMIN_LOGIN: 'off' }))).toBe(false);
    expect(
      canUsePasswordLogin(
        loadConfig({ ...BASE_ENV, PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' })
      )
    ).toBe(false);
  });
});

describe('verifyLocalAdminCredentials', () => {
  it('用户名忽略大小写与首尾空白，口令保持不变', () => {
    expect(verifyLocalAdminCredentials(cfg(), ' OPS-Admin ', 'bootstrap-password-1234')).toBe(true);
    expect(verifyLocalAdminCredentials(cfg(), 'ops-admin', 'BOOTSTRAP-PASSWORD-1234')).toBe(false);
  });

  it('口令不一致 / 空值一律失败', () => {
    expect(verifyLocalAdminCredentials(cfg(), 'ops-admin', 'wrong-password-1234')).toBe(false);
    expect(verifyLocalAdminCredentials(cfg(), '', '')).toBe(false);
  });

  it('未配置凭据时任何输入都失败（fail-closed）', () => {
    const empty = loadConfig({
      ...BASE_ENV,
      PORTAL_ADMIN_USERNAME: '',
      PORTAL_ADMIN_PASSWORD: '',
    });
    expect(verifyLocalAdminCredentials(empty, 'ops-admin', 'bootstrap-password-1234')).toBe(false);
  });
});

describe('localAdminIdentity / isLocalAdminSub', () => {
  it('身份形如 local:<username>，邮箱只用于界面署名', () => {
    expect(localAdminIdentity(cfg())).toEqual({
      sub: 'local:ops-admin',
      email: 'ops-admin@local',
      name: 'ops-admin',
    });
  });

  it('未配置凭据时没有身份', () => {
    expect(
      localAdminIdentity(
        loadConfig({ ...BASE_ENV, PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' })
      )
    ).toBeNull();
  });

  it('按 sub 精确匹配才能获得管理员权限', () => {
    expect(isLocalAdminSub('local:ops-admin', cfg())).toBe(true);
    expect(isLocalAdminSub('local:someone-else', cfg())).toBe(false);
    expect(isLocalAdminSub('100051:teacher-1', cfg())).toBe(false);
  });

  it('SSO 已配齐后身份判定仍然稳定（入口是否关闭由开关决定，不在这里翻转）', () => {
    const ready = ssoReady();
    expect(isLocalAdminSub('local:ops-admin', ready)).toBe(true);
    expect(passwordLoginState(ready)).toBe('available');
  });
});

describe('isPasswordSessionAllowed（请求期 gate）', () => {
  it('SSO 会话不受影响', () => {
    expect(isPasswordSessionAllowed({}, ssoReady())).toBe(true);
  });

  it('SSO 已配齐不再让密码会话失效（只有显式 off 才失效）', () => {
    expect(isPasswordSessionAllowed({ login_method: 'password' }, ssoReady())).toBe(true);
    expect(
      isPasswordSessionAllowed({ login_method: 'password' }, ssoReady({ PORTAL_ADMIN_LOGIN: 'off' }))
    ).toBe(false);
  });

  it('SSO 未配齐时密码会话有效', () => {
    expect(isPasswordSessionAllowed({ login_method: 'password' }, cfg())).toBe(true);
  });

  it('救急开关 on 时密码会话继续有效', () => {
    expect(
      isPasswordSessionAllowed({ login_method: 'password' }, ssoReady({ PORTAL_ADMIN_LOGIN: 'on' }))
    ).toBe(true);
  });
});
