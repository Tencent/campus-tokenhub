import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';

const base = {
  OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
  OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Gateway-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

describe('loadConfig', () => {
  it('解析最小可用配置，并去掉 URL 末尾斜杠', () => {
    const cfg = loadConfig({ ...base, OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789/' });
    expect(cfg.octafuse.adminBase).toBe('http://127.0.0.1:8789');
    expect(cfg.auth.provider).toBe('oauth2');
    expect(cfg.defaults.budgetMax).toBe(20);
  });

  it('缺少必需变量时报中文错误', () => {
    const { OCTAFUSE_PROXY_BASE, ...rest } = base;
    expect(() => loadConfig(rest)).toThrow('OCTAFUSE_PROXY_BASE');
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
    // 实测 .env.dual 曾用 kkkkkk…（44 位同字符），能通过长度与示例串校验，
    // 但 HS256 的密钥空间退化成 1，离线几秒就能还原签名密钥。
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'k'.repeat(44) })).toThrow('熵过低');
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'abcd'.repeat(10) })).toThrow('熵过低');
  });

  it('I1c：正常随机串（hex / base64）不被误伤', () => {
    expect(loadConfig({ ...base, SESSION_SECRET: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' }).auth.sessionSecret)
      .toBe('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6');
  });

  it('URL 协议不对要拒绝', () => {
    expect(() => loadConfig({ ...base, OCTAFUSE_ADMIN_BASE: 'ftp://x' })).toThrow('http/https');
  });

  it('运行期配置不再从环境变量读取', () => {
    // 配置改为只存数据库（设置页）。老部署 .env 里可能还留着这些值：
    // 启动既不能因此报错，也不能让它们生效。
    const cfg = loadConfig({
      ...base,
      AUTH_PROVIDER: 'oauth2',
      OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.edu/oauth2/authorize',
      OAUTH2_CLIENT_ID: '1005',
      OAUTH2_CLIENT_SECRET: 'secret',
      CAS_LOGIN_URL: 'https://cas.example.edu/cas/login',
      DEFAULT_BUDGET_MAX: '500',
      PORTAL_SCHOOL_NAME: '示例学校',
    });
    expect(cfg.auth.provider).toBe('oauth2');
    expect(cfg.auth.oauth2.authorizationEndpoint).toBe('');
    expect(cfg.auth.oauth2.clientId).toBe('');
    expect(cfg.auth.cas.loginUrl).toBe('');
    expect(cfg.defaults.budgetMax).toBe(20);
    expect(cfg.portal.schoolName).toBe('学校');
  });

  it('base 给出协议默认值与安全默认额度，供 overlay 覆盖前使用', () => {
    const cfg = loadConfig(base);
    expect(cfg.auth.oauth2.scopes).toBe('openid profile email');
    expect(cfg.auth.oauth2.tokenAuthMethod).toBe('client_secret_basic');
    expect(cfg.auth.oauth2.userInfoTokenCarrier).toBe('header');
    expect(cfg.defaults.budgetPeriod).toBe('monthly');
    expect(cfg.defaults.rateLimitRpm).toBe(50);
    expect(cfg.defaults.rateLimitTpm).toBe(500000);
  });

  it('字段映射默认留空、登录限制默认关闭', () => {
    const cfg = loadConfig(base);
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

  it('MEMBER_PUBLIC_BASE_URL 留空表示单站部署，配置时去掉尾斜杠', () => {
    expect(loadConfig(base).portal.memberPublicBaseUrl).toBe('');
    const cfg = loadConfig({
      ...base,
      MEMBER_PUBLIC_BASE_URL: 'https://ai.school.edu.cn/tokenhub/member/',
    });
    expect(cfg.portal.memberPublicBaseUrl).toBe('https://ai.school.edu.cn/tokenhub/member');
  });

  it('MEMBER_PUBLIC_BASE_URL 不是合法 URL 要拒绝', () => {
    expect(() => loadConfig({ ...base, MEMBER_PUBLIC_BASE_URL: 'tokenhub/member' })).toThrow(
      'MEMBER_PUBLIC_BASE_URL'
    );
  });

  it('http 的 PUBLIC_BASE_URL 不改 Cookie Secure 默认值', () => {
    const cfg = loadConfig({ ...base, PUBLIC_BASE_URL: 'http://10.0.0.5:3000' });
    expect(cfg.auth.cookieSecure).toBe(false);
  });
});

describe('loadConfig：成员账号配置', () => {
  it('PUBLIC_BASE_URL 留空不报错，由接口层决定降级', () => {
    const cfg = loadConfig(base);
    expect(cfg.portal.publicBaseUrl).toBe('');
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
