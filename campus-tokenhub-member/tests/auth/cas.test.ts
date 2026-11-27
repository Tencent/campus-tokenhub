import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/lib/config';
import {
  buildCasAuthorizationUrl,
  buildCasServiceUrl,
  completeCasAuthorization,
  parseCasJson,
  parseCasXml,
  validateCasTicket,
} from '@/lib/auth/providers/cas';

const config: AppConfig['auth']['cas'] = {
  loginUrl: 'https://cas.example.edu/cas/login',
  ticketValidateUrl: 'https://cas.example.edu/cas/serviceValidate',
};

/** 回调地址不在配置里，由门户按部署域名生成后传入 */
const redirectUri = 'https://portal.example.edu/api/auth/callback';

const tx = {
  state: 'state-1',
  nonce: '',
  codeVerifier: '',
  codeChallenge: '',
  next: '/',
};

const authBase: AppConfig['auth'] = {
  provider: 'cas',
  sessionSecret: 'x'.repeat(40),
  sessionTtlHours: 8,
  cookieSecure: false,
  oauth2: {
    authorizationEndpoint: '',
    tokenEndpoint: '',
    userInfoEndpoint: '',
    clientId: '',
    clientSecret: '',
    scopes: '',
    tokenAuthMethod: 'client_secret_basic',
    userInfoTokenCarrier: 'header',
    fieldMap: {
      subject: '',
      email: '',
      name: '',
      schoolCode: '',
      schoolName: '',
      roles: '',
    },
  },
  cas: config,
  wecom: { corpId: '', agentId: '', secret: '', scope: 'snsapi_base' },
  restrict: {
    enabled: false,
    conditions: [],
  },
  adminRoles: [],
};

describe('CAS 发起登录', () => {
  it('service 为回调地址带 state，并挂在登录 URL 上', () => {
    const url = new URL(buildCasAuthorizationUrl(config, 'state-1', redirectUri));
    expect(url.origin + url.pathname).toBe('https://cas.example.edu/cas/login');
    const service = new URL(url.searchParams.get('service') ?? '');
    expect(service.origin + service.pathname).toBe(redirectUri);
    expect(service.searchParams.get('state')).toBe('state-1');
  });

  it('service 生成可重复（验票时使用同一值）', () => {
    expect(buildCasServiceUrl(redirectUri, 's')).toBe(buildCasServiceUrl(redirectUri, 's'));
  });
});

describe('CAS 校验响应解析', () => {
  it('解析标准 serviceValidate XML', () => {
    const xml = `<?xml version="1.0"?>
<cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas">
  <cas:authenticationSuccess>
    <cas:user>1001</cas:user>
    <cas:attributes>
      <cas:email>student@example.edu</cas:email>
      <cas:name>张三</cas:name>
      <cas:school_name>示例学校</cas:school_name>
      <cas:roles>student</cas:roles>
    </cas:attributes>
  </cas:authenticationSuccess>
</cas:serviceResponse>`;
    const claims = parseCasXml(xml);
    expect(claims).toMatchObject({
      sub: '1001',
      user: '1001',
      email: 'student@example.edu',
      name: '张三',
      school_name: '示例学校',
      roles: 'student',
    });
  });

  it('票据失败时抛 ticket_invalid', () => {
    try {
      parseCasXml('<cas:serviceResponse><cas:authenticationFailure>bad</cas:authenticationFailure></cas:serviceResponse>');
      throw new Error('should-have-thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('ticket_invalid');
    }
  });

  it('解析 JSON 形态校验响应', () => {
    const claims = parseCasJson({
      serviceResponse: {
        authenticationSuccess: {
          user: 'u1',
          attributes: { email: 'a@b.edu', name: '张三', school_code: 'school-a' },
        },
      },
    });
    expect(claims).toMatchObject({ sub: 'u1', email: 'a@b.edu', school_code: 'school-a' });
  });

  it('校验端点：ticket 与 service 都带上，XML/JSON 均可', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<cas:serviceResponse><cas:authenticationSuccess><cas:user>u1</cas:user></cas:authenticationSuccess></cas:serviceResponse>',
      { status: 200 }
    )) as unknown as typeof fetch;
    const claims = await validateCasTicket({
      config,
      ticket: 'ST-1',
      service: 'https://portal.example.edu/api/auth/callback?state=state-1',
      fetchImpl,
    });
    expect(claims.sub).toBe('u1');
    const [url] = vi.mocked(fetchImpl).mock.calls[0];
    expect(String(url)).toContain('ticket=ST-1');
    expect(String(url)).toContain('service=');
  });
});

describe('CAS 回调收尾', () => {
  it('state 不符拒绝，缺 ticket 拒绝', async () => {
    await expect(
      completeCasAuthorization({
        config,
        auth: authBase,
        tx,
        callback: { ticket: 'ST-1', state: 'wrong' },
        redirectUri,
      })
    ).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(
      completeCasAuthorization({
        config,
        auth: authBase,
        tx,
        callback: { state: 'state-1' },
        redirectUri,
      })
    ).rejects.toMatchObject({ code: 'ticket_missing' });
  });

  it('校验票据 → 校验登录限制 → 产出 Identity', async () => {
    const identity = await completeCasAuthorization({
      config,
      auth: {
        ...authBase,
        restrict: {
          enabled: true,
          conditions: [{ field: 'roles', path: '', value: 'student' }],
        },
      },
      tx,
      callback: { ticket: 'ST-1', state: 'state-1' },
      redirectUri,
      deps: {
        validateTicket: async () => ({
          sub: 'u1',
          email: 'a@b.edu',
          name: '张三',
          school_name: '示例学校',
          roles: ['student'],
        }),
      },
    });
    expect(identity.sub).toBe('u1');
    expect(identity.schoolName).toBe('示例学校');
  });

  it('限制不命中时拒绝登录', async () => {
    await expect(
      completeCasAuthorization({
        config,
        auth: {
          ...authBase,
          restrict: {
            enabled: true,
            conditions: [{ field: 'roles', path: '', value: 'teacher' }],
          },
        },
        tx,
        callback: { ticket: 'ST-1', state: 'state-1' },
        redirectUri,
        deps: {
          validateTicket: async () => ({ sub: 'u1', roles: ['student'] }),
        },
      })
    ).rejects.toMatchObject({ code: 'login_restricted' });
  });
});
