import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '@/lib/config';
import type { RestrictCondition } from '@/lib/config/fields';
import {
  buildOAuth2AuthorizationUrl,
  completeOAuth2Authorization,
  exchangeOAuth2Token,
  fetchOAuth2UserInfo,
} from '@/lib/auth/providers/oauth2';
import {
  claim,
  claimList,
  establishIdentity,
  identityFromClaims,
  readClaimPath,
} from '@/lib/auth/providers/identity';
import { authErrorCode } from '@/lib/auth/providers/registry';

const emptyFieldMap: AppConfig['auth']['oauth2']['fieldMap'] = {
  subject: '',
  email: '',
  name: '',
  schoolCode: '',
  schoolName: '',
  roles: '',
};

const config: AppConfig['auth']['oauth2'] = {
  authorizationEndpoint: 'https://idp.example.edu/oauth2/authorize',
  tokenEndpoint: 'https://idp.example.edu/oauth2/token',
  userInfoEndpoint: 'https://idp.example.edu/oauth2/userinfo',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  scopes: 'openid profile email',
  tokenAuthMethod: 'client_secret_basic',
  userInfoTokenCarrier: 'header',
  fieldMap: emptyFieldMap,
};

/** 回调地址不在配置里，由门户按部署域名生成后传入 */
const redirectUri = 'https://portal.example.edu/api/auth/callback';

const tx = {
  state: 'state-1',
  nonce: 'nonce-1',
  codeVerifier: 'verifier-1',
  codeChallenge: 'challenge-1',
  next: '/',
};

const authBase: AppConfig['auth'] = {
  provider: 'oauth2',
  sessionSecret: 'x'.repeat(40),
  sessionTtlHours: 8,
  cookieSecure: false,
  oauth2: config,
  cas: {
    loginUrl: 'https://cas.example.edu/cas/login',
    ticketValidateUrl: 'https://cas.example.edu/cas/serviceValidate',
  },
  wecom: { corpId: '', agentId: '', secret: '', scope: 'snsapi_base' },
  restrict: {
    enabled: false,
    conditions: [],
  },
  adminRoles: [],
};

describe('标准 OAuth2 授权 URL', () => {
  it('带上标准参数与 PKCE challenge', () => {
    const url = new URL(buildOAuth2AuthorizationUrl(config, tx, redirectUri));
    expect(url.origin + url.pathname).toBe('https://idp.example.edu/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('scope 留空时回落默认值', () => {
    const url = new URL(buildOAuth2AuthorizationUrl({ ...config, scopes: '' }, tx, redirectUri));
    expect(url.searchParams.get('scope')).toBe('openid profile email');
  });

  it('hash 路由授权页：参数追加到 # 之后，并保留原有查询参数', () => {
    const url = buildOAuth2AuthorizationUrl(
      {
        ...config,
        authorizationEndpoint: 'https://ai.example.com/learning/#/login/oauth2?corp_code=demo',
      },
      tx,
      redirectUri
    );
    const [base, fragment] = url.split('#');
    expect(base).toBe('https://ai.example.com/learning/');
    expect(fragment.startsWith('/login/oauth2?')).toBe(true);

    const params = new URLSearchParams(fragment.slice(fragment.indexOf('?') + 1));
    expect(params.get('corp_code')).toBe('demo');
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('redirect_uri')).toBe(redirectUri);
    expect(params.get('state')).toBe('state-1');
    expect(params.get('code_challenge')).toBe('challenge-1');
    expect(params.get('code_challenge_method')).toBe('S256');
  });
});

describe('标准 OAuth2 token 与 userinfo', () => {
  it('Basic 方式把 client 凭证放在请求头', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const token = await exchangeOAuth2Token({
      config,
      code: 'code-1',
      codeVerifier: tx.codeVerifier,
      redirectUri,
      fetchImpl,
    });
    expect(token).toBe('tok');
    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${Buffer.from('client-1:secret-1').toString('base64')}`);
    expect(String(init?.body)).toContain('code_verifier=verifier-1');
  });

  it('Post 方式把 client 凭证放在表单体', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    await exchangeOAuth2Token({
      config: { ...config, tokenAuthMethod: 'client_secret_post' },
      code: 'code-1',
      codeVerifier: tx.codeVerifier,
      redirectUri,
      fetchImpl,
    });
    const [, init] = vi.mocked(fetchImpl).mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
    expect(String(init?.body)).toContain('client_secret=secret-1');
  });

  it('userinfo token 可走请求头或查询参数', async () => {
    const headerFetch = vi.fn(async () => new Response(JSON.stringify({ sub: 'u1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    await fetchOAuth2UserInfo({ config, accessToken: 'tok', fetchImpl: headerFetch });
    const [headerUrl, headerInit] = vi.mocked(headerFetch).mock.calls[0];
    expect(String(headerUrl)).not.toContain('access_token');
    expect((headerInit?.headers as Record<string, string>).authorization).toBe('Bearer tok');

    const queryFetch = vi.fn(async () => new Response(JSON.stringify({ sub: 'u1' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    await fetchOAuth2UserInfo({
      config: { ...config, userInfoTokenCarrier: 'query' },
      accessToken: 'tok',
      fetchImpl: queryFetch,
    });
    const [queryUrl] = vi.mocked(queryFetch).mock.calls[0];
    expect(String(queryUrl)).toContain('access_token=tok');
  });
});

describe('字段映射', () => {
  it('取常见 claim 写法', () => {
    expect(claim({ user_id: 42 }, ['sub', 'user_id'])).toBe('42');
    expect(claimList({ roles: ['teacher', 'admin'] }, ['roles'])).toEqual(['teacher', 'admin']);
    expect(claimList({ role: 'student,teacher' }, ['role'])).toEqual(['student', 'teacher']);
    const identity = identityFromClaims({
      sub: 'u1',
      email: 'a@b.edu',
      name: '张三',
      school_name: '示例学校',
    });
    expect(identity).toMatchObject({ sub: 'u1', email: 'a@b.edu', name: '张三', schoolName: '示例学校' });
  });

  it('邮箱缺失时用 sub 派生，避免网关开户空邮箱', () => {
    expect(identityFromClaims({ sub: 'school:1001' }).email).toBe('school-1001@school.local');
    expect(identityFromClaims({ sub: 'CorpId/1001' }).email).toBe('CorpId-1001@school.local');
  });

  it('按映射模板与级联路径取身份', () => {
    const identity = identityFromClaims(
      {
        data: { name: '张三' },
        user_id: 17908,
        school_id: 100051,
        school_name: '演示学校',
        role_name: '老师',
      },
      {
        subject: '{school_id}:{user_id}',
        email: '',
        name: 'data.name',
        schoolCode: 'school_id',
        schoolName: 'school_name',
        roles: 'role_name',
      }
    );
    expect(identity.sub).toBe('100051:17908');
    expect(identity.name).toBe('张三');
    expect(identity.schoolName).toBe('演示学校');
  });

  it('级联路径支持点号与数组下标', () => {
    expect(readClaimPath({ data: { user_id: 7 } }, 'data.user_id')).toBe(7);
    expect(readClaimPath({ data: [{ id: 'a1' }] }, 'data.0.id')).toBe('a1');
    expect(readClaimPath({ data: null }, 'data.user_id')).toBeUndefined();
  });

  it('配置了映射但字段缺失时不回退别名', () => {
    try {
      identityFromClaims({ sub: 'u1' }, { ...emptyFieldMap, subject: 'user_id' });
      throw new Error('should-have-thrown');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('identity_invalid');
    }
  });

  it('映射留空时仍走内置兼容字段', () => {
    expect(identityFromClaims({ sub: 'u1' }, emptyFieldMap).sub).toBe('u1');
  });
});

describe('登录限制', () => {
  const claims = { school_id: 100051, user_id: 17908, role_name: '老师' };
  const fieldMap: AppConfig['auth']['oauth2']['fieldMap'] = {
    ...emptyFieldMap,
    subject: 'user_id',
    schoolCode: 'school_id',
    roles: 'role_name',
  };
  const restricted = (conditions: RestrictCondition[]): AppConfig['auth'] => ({
    ...authBase,
    restrict: { enabled: true, conditions },
  });
  const condition = (
    field: RestrictCondition['field'],
    value: string,
    path = ''
  ): RestrictCondition => ({ field, path, value });

  it('关闭时不限制任何账号', () => {
    const identity = establishIdentity({ auth: authBase, claims, fieldMap });
    expect(identity.sub).toBe('17908');
  });

  it('按映射后的学校编码命中', () => {
    const identity = establishIdentity({
      auth: restricted([condition('schoolCode', '100051')]),
      claims,
      fieldMap,
    });
    expect(identity.sub).toBe('17908');
  });

  it('不命中时抛 login_restricted', () => {
    expect(() =>
      establishIdentity({
        auth: restricted([condition('schoolCode', '999')]),
        claims,
        fieldMap,
      })
    ).toThrowError(expect.objectContaining({ code: 'login_restricted' }));
  });

  it('角色限制按映射字段匹配', () => {
    expect(() =>
      establishIdentity({
        auth: restricted([condition('roles', '老师')]),
        claims,
        fieldMap,
      })
    ).not.toThrow();
  });

  it('自定义级联字段可用于限制', () => {
    expect(() =>
      establishIdentity({
        auth: restricted([condition('custom', 's-1', 'data.school.id')]),
        claims: { user_id: 17908, school_id: 100051, data: { school: { id: 's-1' } } },
        fieldMap,
      })
    ).not.toThrow();
  });

  it('多条条件之间是「且」：全部命中才放行', () => {
    const auth = restricted([condition('schoolCode', '100051'), condition('roles', '老师')]);
    expect(() => establishIdentity({ auth, claims, fieldMap })).not.toThrow();
    expect(() =>
      establishIdentity({ auth, claims: { ...claims, role_name: '学生' }, fieldMap })
    ).toThrowError(expect.objectContaining({ code: 'login_restricted' }));
  });

  it('配置不完整时 fail closed', () => {
    expect(() =>
      establishIdentity({
        auth: restricted([condition('custom', 's-1', '  ')]),
        claims,
        fieldMap,
      })
    ).toThrowError(expect.objectContaining({ code: 'restrict_misconfigured' }));

    expect(() =>
      establishIdentity({
        auth: restricted([]),
        claims,
        fieldMap,
      })
    ).toThrowError(expect.objectContaining({ code: 'restrict_misconfigured' }));

    expect(() =>
      establishIdentity({
        auth: restricted([condition('schoolCode', '   ')]),
        claims,
        fieldMap,
      })
    ).toThrowError(expect.objectContaining({ code: 'restrict_misconfigured' }));
  });
});

describe('回调收尾', () => {
  it('state 不符时拒绝', async () => {
    await expect(
      completeOAuth2Authorization({
        config,
        auth: authBase,
        tx,
        callback: { code: 'c', state: 'wrong' },
        redirectUri,
      })
    ).rejects.toMatchObject({ code: 'state_mismatch' });
  });

  it('缺 code 时拒绝', async () => {
    await expect(
      completeOAuth2Authorization({
        config,
        auth: authBase,
        tx,
        callback: { state: 'state-1' },
        redirectUri,
      })
    ).rejects.toMatchObject({ code: 'code_missing' });
  });

  it('换 token → 读身份 → 校验登录限制 → 产出 Identity', async () => {
    const identity = await completeOAuth2Authorization({
      config,
      auth: {
        ...authBase,
        restrict: {
          enabled: true,
          conditions: [{ field: 'schoolName', path: '', value: '示例学校' }],
        },
      },
      tx,
      callback: { code: 'c', state: 'state-1' },
      redirectUri,
      deps: {
        exchangeToken: async () => 'tok',
        fetchUserInfo: async () => ({
          sub: 'u1',
          email: 'a@b.edu',
          name: '张三',
          school_name: '示例学校',
        }),
      },
    });
    expect(identity.sub).toBe('u1');
    expect(identity.schoolName).toBe('示例学校');
  });
});

describe('错误码提取', () => {
  it('从带 code 的错误对象取码', () => {
    expect(authErrorCode({ code: 'login_restricted' })).toBe('login_restricted');
    expect(authErrorCode({ code: 123 })).toBeNull();
  });
});
