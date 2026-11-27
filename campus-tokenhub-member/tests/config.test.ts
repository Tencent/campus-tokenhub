import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';

const base = {
  OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
  OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'pw',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

describe('loadConfig', () => {
  it('解析最小可用配置，并去掉 URL 末尾斜杠', () => {
    const cfg = loadConfig({ ...base, OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789/' });
    expect(cfg.auth.provider).toBe('oauth2');
    expect(cfg.defaults.budgetMax).toBe(100);
  });

  it('ADMIN_EMAILS 已移除：配置了也不再生效（管理员只认名单表）', () => {
    const cfg = loadConfig({ ...base, ADMIN_EMAILS: 'a@x.edu' });
    expect('adminEmails' in cfg.portal).toBe(false);
  });

  it('SESSION_SECRET 太短要拒绝', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow('SESSION_SECRET');
  });

  it('I1：拒绝 .env.example 里的公开示例密钥', () => {
    expect(() =>
      loadConfig({ ...base, SESSION_SECRET: 'please-change-this-to-a-random-32-char-secret' })
    ).toThrow('示例');
  });

  it('I1b：拒绝「长度够但只有一种字符」的弱密钥', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'x'.repeat(40) })).toThrow('熵过低');
  });

  it('provider=oauth2 时缺标准端点要拒绝', () => {
    expect(() => loadConfig({ ...base, AUTH_PROVIDER: 'oauth2' })).toThrow(
      'OAUTH2_AUTHORIZATION_ENDPOINT'
    );
  });

  it('provider=oauth2 且参数齐全时可用，端点去尾斜杠', () => {
    const cfg = loadConfig({
      ...base,
      AUTH_PROVIDER: 'oauth2',
      OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.edu/oauth2/authorize/',
      OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.edu/oauth2/token',
      OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.edu/oauth2/userinfo',
      OAUTH2_CLIENT_ID: '1005',
      OAUTH2_CLIENT_SECRET: 'secret',
    });
    expect(cfg.auth.oauth2.authorizationEndpoint).toBe('https://idp.example.edu/oauth2/authorize');
    expect(cfg.auth.oauth2.tokenEndpoint).toBe('https://idp.example.edu/oauth2/token');
    expect(cfg.auth.oauth2.userInfoEndpoint).toBe('https://idp.example.edu/oauth2/userinfo');
    expect(cfg.auth.oauth2.clientId).toBe('1005');
    expect(cfg.auth.oauth2.scopes).toBe('openid profile email');
    expect(cfg.auth.oauth2.tokenAuthMethod).toBe('client_secret_basic');
    expect(cfg.auth.oauth2.userInfoTokenCarrier).toBe('header');
  });

  it('旧值 aie 归一化为 oauth2（兼容已有部署环境变量）', () => {
    const cfg = loadConfig({
      ...base,
      AUTH_PROVIDER: 'aie',
      OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.edu/oauth2/authorize',
      OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.edu/oauth2/token',
      OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.edu/oauth2/userinfo',
      OAUTH2_CLIENT_ID: '1005',
      OAUTH2_CLIENT_SECRET: 'secret',
    });
    expect(cfg.auth.provider).toBe('oauth2');
  });

  it('provider=cas 时缺认证地址要拒绝', () => {
    expect(() =>
      loadConfig({
        ...base,
        AUTH_PROVIDER: 'cas',
      })
    ).toThrow('CAS_LOGIN_URL');
  });

  it('provider=cas 且参数齐全时可用', () => {
    const cfg = loadConfig({
      ...base,
      AUTH_PROVIDER: 'cas',
      CAS_LOGIN_URL: 'https://cas.example.edu/cas/login/',
      CAS_TICKET_VALIDATE_URL: 'https://cas.example.edu/cas/serviceValidate',
    });
    expect(cfg.auth.cas.loginUrl).toBe('https://cas.example.edu/cas/login');
    expect(cfg.auth.cas.ticketValidateUrl).toBe('https://cas.example.edu/cas/serviceValidate');
  });

  it('字段映射默认留空、登录限制默认关闭', () => {
    const cfg = loadConfig({
      ...base,
      AUTH_PROVIDER: 'oauth2',
      OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.edu/oauth2/authorize',
      OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.edu/oauth2/token',
      OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.edu/oauth2/userinfo',
      OAUTH2_CLIENT_ID: '1005',
      OAUTH2_CLIENT_SECRET: 'secret',
    });
    expect(cfg.auth.oauth2.fieldMap).toEqual({
      subject: '',
      email: '',
      name: '',
      schoolCode: '',
      schoolName: '',
      roles: '',
    });
    expect(cfg.auth.restrict).toEqual({
      enabled: false,
      conditions: [],
    });
  });

  it('AUTH_PROVIDER 只接受 oauth2 / cas（aie 为兼容别名）', () => {
    expect(() => loadConfig({ ...base, AUTH_PROVIDER: 'saml' })).toThrow('AUTH_PROVIDER');
    expect(() => loadConfig({ ...base, AUTH_PROVIDER: 'mock' })).toThrow('AUTH_PROVIDER');
    expect(() => loadConfig({ ...base, AUTH_PROVIDER: 'oidc' })).toThrow('AUTH_PROVIDER');
  });

  it('生产环境仍允许真实的认证方式', () => {
    const cfg = loadConfig({ ...base, NODE_ENV: 'production' });
    expect(cfg.auth.provider).toBe('oauth2');
  });

  it('PUBLIC_BASE_URL 去尾斜杠，https 时强制 Secure Cookie', () => {
    const cfg = loadConfig({ ...base, PUBLIC_BASE_URL: 'https://ai.school.edu.cn/' });
    expect(cfg.portal.publicBaseUrl).toBe('https://ai.school.edu.cn');
    expect(cfg.auth.cookieSecure).toBe(true);
  });

  it('PUBLIC_BASE_URL 不是合法 URL 要拒绝', () => {
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'ai.school.edu.cn' })).toThrow(
      'PUBLIC_BASE_URL'
    );
  });

  it('http 的 PUBLIC_BASE_URL 不改 Cookie Secure 默认值', () => {
    const cfg = loadConfig({ ...base, PUBLIC_BASE_URL: 'http://10.0.0.5:3000' });
    expect(cfg.auth.cookieSecure).toBe(false);
  });

  it('预算不是正数要拒绝', () => {
    expect(() => loadConfig({ ...base, DEFAULT_BUDGET_MAX: '0' })).toThrow('DEFAULT_BUDGET_MAX');
  });
});

describe('loadConfig：成员账号配置', () => {
  it('缺省值：权限 [1,2,5,6]、Financial、ap-guangzhou、./.data、provider=tencent', () => {
    const cfg = loadConfig(base);
    expect(cfg.memberAccount.permissionIds).toEqual([1, 2, 5, 6]);
    expect(cfg.memberAccount.policyType).toBe('Financial');
    expect(cfg.memberAccount.provider).toBe('tencent');
    expect(cfg.tencentCloud.region).toBe('ap-guangzhou');
    expect(cfg.tencentCloud.endpoint).toBe('organization.tencentcloudapi.com');
    expect(cfg.portalDataDir).toBe('./.data');
  });

  it('根节点 ID 不再是配置项：env 里给了值也不读取', () => {
    const cfg = loadConfig({ ...base, MEMBER_ACCOUNT_ROOT_NODE_ID: '1001' });
    expect('rootNodeId' in cfg.memberAccount).toBe(false);
    // 非法值也不再触发启动错误
    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_ROOT_NODE_ID: 'abc' })).not.toThrow();
  });

  it('权限列表去重排序，且必须包含 1、2', () => {
    const cfg = loadConfig({ ...base, MEMBER_ACCOUNT_PERMISSION_IDS: '2,1,2' });
    expect(cfg.memberAccount.permissionIds).toEqual([1, 2]);

    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_PERMISSION_IDS: '1' })).toThrow('1、2');
  });

  it('权限含非数字要拒绝', () => {
    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_PERMISSION_IDS: '1,2,abc' })).toThrow(
      'MEMBER_ACCOUNT_PERMISSION_IDS'
    );
  });

  it('权限超出 1-10 要拒绝', () => {
    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_PERMISSION_IDS: '1,2,11' })).toThrow(
      'MEMBER_ACCOUNT_PERMISSION_IDS'
    );
  });

  it('POLICY_TYPE 只接受 Financial', () => {
    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_POLICY_TYPE: 'Reseller' })).toThrow(
      'MEMBER_ACCOUNT_POLICY_TYPE'
    );
  });

  it('MEMBER_ACCOUNT_PROVIDER 只接受 tencent / mock', () => {
    expect(() => loadConfig({ ...base, MEMBER_ACCOUNT_PROVIDER: 'aliyun' })).toThrow(
      'MEMBER_ACCOUNT_PROVIDER'
    );
    expect(loadConfig({ ...base, MEMBER_ACCOUNT_PROVIDER: 'mock' }).memberAccount.provider).toBe(
      'mock'
    );
  });

  it('生产环境拒绝 MEMBER_ACCOUNT_PROVIDER=mock', () => {
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        MEMBER_ACCOUNT_PROVIDER: 'mock',
      })
    ).toThrow('MEMBER_ACCOUNT_PROVIDER=mock');
  });

  it('PUBLIC_BASE_URL 留空不报错，由接口层决定降级', () => {
    const cfg = loadConfig(base);
    expect(cfg.portal.publicBaseUrl).toBe('');
  });

  it('腾讯云密钥缺省为空串（不强制，未配置时功能降级）', () => {
    const cfg = loadConfig(base);
    expect(cfg.tencentCloud.secretId).toBe('');
    expect(cfg.tencentCloud.secretKey).toBe('');
  });
});

describe('loadConfig：引导期账号密码登录', () => {
  const creds = {
    PORTAL_ADMIN_USERNAME: 'ops-admin',
    PORTAL_ADMIN_PASSWORD: 'a-long-enough-pw-123',
  };

  it('默认未配置：账号口令为空、开关 auto', () => {
    const cfg = loadConfig(base);
    expect(cfg.portal.localAdmin).toEqual({ username: '', password: '', mode: 'auto' });
  });

  it('两项齐全时生效，用户名去空白', () => {
    const cfg = loadConfig({ ...base, ...creds, PORTAL_ADMIN_USERNAME: ' ops-admin ' });
    expect(cfg.portal.localAdmin.username).toBe('ops-admin');
    expect(cfg.portal.localAdmin.password).toBe(creds.PORTAL_ADMIN_PASSWORD);
  });

  it('只配一项视为未配置（fail-closed）', () => {
    const onlyUser = loadConfig({ ...base, PORTAL_ADMIN_USERNAME: 'ops-admin' });
    expect(onlyUser.portal.localAdmin).toEqual({ username: '', password: '', mode: 'auto' });

    const onlyPassword = loadConfig({ ...base, PORTAL_ADMIN_PASSWORD: creds.PORTAL_ADMIN_PASSWORD });
    expect(onlyPassword.portal.localAdmin).toEqual({ username: '', password: '', mode: 'auto' });
  });

  it('口令短于 12 字符拒绝启动', () => {
    expect(() => loadConfig({ ...base, ...creds, PORTAL_ADMIN_PASSWORD: 'short-pw' })).toThrow(
      'PORTAL_ADMIN_PASSWORD'
    );
  });

  it('示例口令拒绝启动', () => {
    expect(() =>
      loadConfig({ ...base, ...creds, PORTAL_ADMIN_PASSWORD: 'change-me-please-1234' })
    ).toThrow('示例');
  });

  it('PORTAL_ADMIN_LOGIN 只接受 auto / on / off，其余回退 auto', () => {
    expect(loadConfig({ ...base, ...creds, PORTAL_ADMIN_LOGIN: 'off' }).portal.localAdmin.mode).toBe('off');
    expect(loadConfig({ ...base, ...creds, PORTAL_ADMIN_LOGIN: 'ON' }).portal.localAdmin.mode).toBe('on');
    expect(loadConfig({ ...base, ...creds, PORTAL_ADMIN_LOGIN: 'yes' }).portal.localAdmin.mode).toBe('auto');
  });
});
