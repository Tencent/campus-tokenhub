import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig, WecomAuthConfig } from '@/lib/config';
import type { CompleteLoginInput } from '@/lib/auth/providers/types';
import {
  buildWecomAuthorizationUrl,
  buildWecomQrLoginUrl,
  completeWecomAuthorization,
  fetchWecomProfile,
  getWecomAccessToken,
  getWecomUserId,
  wecomAdapter,
} from '@/lib/auth/providers/wecom';

vi.mock('@/lib/auth/login', () => ({
  authCallbackUrl: () => 'https://portal.example.edu/api/auth/callback',
}));

const redirectUri = 'https://portal.example.edu/api/auth/callback';
const tx = {
  state: 'state-1',
  nonce: 'nonce-1',
  codeVerifier: '',
  codeChallenge: '',
  next: '/',
};

let secretSeq = 0;
/** 每次生成独立 Secret，避免进程内 token 缓存在用例之间互相污染 */
function wecomConfig(overrides: Partial<WecomAuthConfig> = {}): WecomAuthConfig {
  secretSeq += 1;
  return {
    corpId: 'ww-test',
    agentId: '1000002',
    secret: `secret-${secretSeq}`,
    scope: 'snsapi_base',
    ...overrides,
  };
}

const authBase: AppConfig['auth'] = {
  provider: 'wecom',
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
  cas: { loginUrl: '', ticketValidateUrl: '' },
  wecom: wecomConfig(),
  restrict: { enabled: false, conditions: [] },
  adminRoles: [],
};

function appConfig(config: WecomAuthConfig): AppConfig {
  return { auth: { ...authBase, provider: 'wecom', wecom: config } } as AppConfig;
}

function completeInput(
  config: WecomAuthConfig,
  overrides: Partial<CompleteLoginInput> = {}
): CompleteLoginInput {
  return {
    request: new Request('https://portal.example.edu/login'),
    config: appConfig(config),
    tx,
    callback: { code: 'code-1', state: tx.state },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeFetch(
  handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>
): { fetchImpl: typeof fetch; urls: string[]; bodies: string[] } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    bodies.push(typeof init?.body === 'string' ? init.body : '');
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls, bodies };
}

function routeFetch(routes: {
  token?: unknown;
  userinfo?: unknown;
  detail?: unknown;
  user?: unknown;
}): { fetchImpl: typeof fetch; urls: string[]; bodies: string[] } {
  return makeFetch((url) => {
    if (url.includes('/cgi-bin/gettoken')) {
      return jsonResponse(
        routes.token ?? { errcode: 0, access_token: 'tok', expires_in: 7200 }
      );
    }
    if (url.includes('/cgi-bin/auth/getuserinfo')) {
      return jsonResponse(routes.userinfo ?? { errcode: 0, userid: 'u1' });
    }
    if (url.includes('/cgi-bin/auth/getuserdetail')) {
      return jsonResponse(routes.detail ?? { errcode: 0 });
    }
    if (url.includes('/cgi-bin/user/get')) {
      return jsonResponse(routes.user ?? { errcode: 0 });
    }
    return jsonResponse({ errcode: -1, errmsg: 'unexpected endpoint' }, 500);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('企微发起登录 URL', () => {
  it('网页授权参数齐全，回调地址编码，#wechat_redirect 在末尾', () => {
    const url = buildWecomAuthorizationUrl(
      wecomConfig({ scope: 'snsapi_privateinfo' }),
      tx,
      redirectUri
    );
    expect(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?')).toBe(true);
    expect(url.endsWith('#wechat_redirect')).toBe(true);

    const [base, fragment] = url.split('#');
    expect(fragment).toBe('wechat_redirect');
    expect(base).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    const params = new URLSearchParams(base.slice(base.indexOf('?') + 1));
    expect(params.get('appid')).toBe('ww-test');
    expect(params.get('redirect_uri')).toBe(redirectUri);
    expect(params.get('response_type')).toBe('code');
    expect(params.get('scope')).toBe('snsapi_privateinfo');
    expect(params.get('state')).toBe('state-1');
    expect(params.get('agentid')).toBe('1000002');
  });

  it('扫码参数含 login_type / appid / agentid / redirect_uri / state / redirect_type', () => {
    const url = new URL(buildWecomQrLoginUrl(wecomConfig(), tx, redirectUri));
    expect(url.origin).toBe('https://login.work.weixin.qq.com');
    expect(url.searchParams.get('login_type')).toBe('CorpApp');
    expect(url.searchParams.get('appid')).toBe('ww-test');
    expect(url.searchParams.get('agentid')).toBe('1000002');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('redirect_type')).toBe('callback');
  });

  it('adapter.start 使用门户回调地址构造企微授权链接', async () => {
    const url = await wecomAdapter.start({
      request: new Request('https://portal.example.edu/login'),
      config: appConfig(wecomConfig()),
      tx,
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      'https://open.weixin.qq.com/connect/oauth2/authorize'
    );
    expect(parsed.searchParams.get('redirect_uri')).toContain('/api/auth/callback');
    expect(wecomAdapter.kind).toBe('wecom');
    expect(wecomAdapter.requiresRedirect).toBe(true);
    expect(wecomAdapter.label).toBe('使用企业微信登录');
  });
});

describe('企微 access_token 缓存', () => {
  it('命中缓存不重复请求，过期后重新获取', async () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    let tokenCall = 0;
    const { fetchImpl, urls } = makeFetch((url) => {
      if (url.includes('/cgi-bin/gettoken')) {
        tokenCall += 1;
        return jsonResponse({ errcode: 0, access_token: `tok-${tokenCall}`, expires_in: 3600 });
      }
      return jsonResponse({ errcode: -1 }, 500);
    });
    const config = wecomConfig();

    expect(await getWecomAccessToken(config, { fetch: fetchImpl })).toBe('tok-1');
    expect(await getWecomAccessToken(config, { fetch: fetchImpl })).toBe('tok-1');
    expect(tokenCall).toBe(1);

    nowSpy.mockReturnValue(1_700_000_000_000 + 3301_000);
    expect(await getWecomAccessToken(config, { fetch: fetchImpl })).toBe('tok-2');
    expect(urls).toHaveLength(2);
  });

  it('并发调用共享同一个在途请求（单飞）', async () => {
    let release!: (response: Response) => void;
    const { fetchImpl, urls } = makeFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const config = wecomConfig();

    const first = getWecomAccessToken(config, { fetch: fetchImpl });
    const second = getWecomAccessToken(config, { fetch: fetchImpl });
    expect(urls).toHaveLength(1);

    release(jsonResponse({ errcode: 0, access_token: 'tok-shared', expires_in: 7200 }));
    expect(await first).toBe('tok-shared');
    expect(await second).toBe('tok-shared');
    expect(urls).toHaveLength(1);
  });

  it('Secret 变化后不复用旧 token', async () => {
    const { fetchImpl, urls } = makeFetch((url) => {
      const secret = new URL(url).searchParams.get('corpsecret');
      return jsonResponse({ errcode: 0, access_token: `tok-${secret}`, expires_in: 7200 });
    });
    const first = wecomConfig();
    const rotated = { ...first, secret: 'rotated-secret-value' };

    expect(await getWecomAccessToken(first, { fetch: fetchImpl })).toBe(`tok-${first.secret}`);
    expect(await getWecomAccessToken(rotated, { fetch: fetchImpl })).toBe(
      'tok-rotated-secret-value'
    );
    expect(urls).toHaveLength(2);
  });

  it('上游 errcode 失败时抛 wecom_token_failed，错误文案不含上游信息', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = wecomConfig();
    const secret = config.secret;
    const { fetchImpl } = routeFetch({ token: { errcode: 40001, errmsg: 'invalid secret' } });

    await expect(getWecomAccessToken(config, { fetch: fetchImpl })).rejects.toMatchObject({
      code: 'wecom_token_failed',
    });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).toContain('invalid secret');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
  });
});

describe('企微 auth/getuserinfo', () => {
  it('token 失效时清缓存并换取新 token 重试一次', async () => {
    const config = wecomConfig();
    let userinfoCall = 0;
    const { fetchImpl, urls } = makeFetch((url) => {
      if (url.includes('/cgi-bin/gettoken')) {
        return jsonResponse({ errcode: 0, access_token: 'fresh-token', expires_in: 7200 });
      }
      if (url.includes('/cgi-bin/auth/getuserinfo')) {
        userinfoCall += 1;
        return jsonResponse(
          userinfoCall === 1
            ? { errcode: 42001, errmsg: 'access_token expired' }
            : { errcode: 0, userid: 'u-retry' }
        );
      }
      return jsonResponse({ errcode: -1 }, 500);
    });

    const result = await getWecomUserId(
      { ...config, accessToken: 'stale-token', code: 'code-1' },
      { fetch: fetchImpl }
    );
    expect(result.userid).toBe('u-retry');
    expect(urls.some((url) => url.includes('access_token=fresh-token'))).toBe(true);
  });

  it('重试仍失效时抛 wecom_token_failed', async () => {
    const config = wecomConfig();
    const { fetchImpl } = makeFetch((url) => {
      if (url.includes('/cgi-bin/gettoken')) {
        return jsonResponse({ errcode: 0, access_token: 'fresh-token', expires_in: 7200 });
      }
      return jsonResponse({ errcode: 40014, errmsg: 'invalid access_token' });
    });

    await expect(
      getWecomUserId({ ...config, accessToken: 'stale-token', code: 'code-1' }, { fetch: fetchImpl })
    ).rejects.toMatchObject({ code: 'wecom_token_failed' });
  });
});

describe('企微资料补全', () => {
  it('有 user_ticket 时走 getuserdetail，使用姓名与邮箱', async () => {
    const config = wecomConfig();
    const { fetchImpl, urls, bodies } = routeFetch({
      userinfo: { errcode: 0, userid: 'u1', user_ticket: 'ticket' },
      detail: { errcode: 0, name: '张三', email: 'zhang@example.edu', department: '教务处' },
      user: { errcode: 0, name: '李四' },
    });
    const identity = await completeWecomAuthorization(completeInput(config), { fetch: fetchImpl });
    expect(identity.name).toBe('张三');
    expect(identity.email).toBe('zhang@example.edu');
    expect(urls.some((url) => url.includes('/cgi-bin/auth/getuserdetail'))).toBe(true);
    expect(bodies.some((body) => body.includes('"user_ticket":"ticket"'))).toBe(true);
    expect(urls.some((url) => url.includes('/cgi-bin/user/get'))).toBe(false);
  });

  it('无 user_ticket 时走 user/get', async () => {
    const config = wecomConfig();
    const { fetchImpl, urls } = routeFetch({
      userinfo: { errcode: 0, userid: 'u-profile' },
      user: { errcode: 0, name: '王五', email: 'wang@example.edu', position: '老师' },
    });
    const identity = await completeWecomAuthorization(completeInput(config), { fetch: fetchImpl });
    expect(identity.name).toBe('王五');
    expect(identity.email).toBe('wang@example.edu');
    expect(urls.some((url) => url.includes('/cgi-bin/user/get?'))).toBe(true);
    expect(urls.some((url) => url.includes('userid=u-profile'))).toBe(true);
  });

  it('资料接口失败只告警并降级，不阻断登录', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = wecomConfig();
    const { fetchImpl } = routeFetch({
      userinfo: { errcode: 0, userid: 'u-degrade' },
      user: { errcode: 60011, errmsg: 'no privilege' },
    });
    const identity = await completeWecomAuthorization(completeInput(config), { fetch: fetchImpl });
    expect(identity.sub).toBe('u-degrade');
    expect(identity.name).toBe('u-degrade');
    expect(identity.email).toBe('u-degrade@school.local');
    expect(warn).toHaveBeenCalled();
  });

  it('fetchWecomProfile 失败时返回空对象', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchImpl } = makeFetch(async () => {
      throw new Error('network down');
    });
    const config = wecomConfig();
    expect(
      await fetchWecomProfile(
        { ...config, accessToken: 'tok', userid: 'u1' },
        { fetch: fetchImpl }
      )
    ).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe('企微回调收尾', () => {
  it('事务缺失 / state 不匹配 / 拒绝授权分别拒绝', async () => {
    const config = wecomConfig();
    await expect(
      completeWecomAuthorization(completeInput(config, { tx: null }))
    ).rejects.toMatchObject({ code: 'tx_missing' });
    await expect(
      completeWecomAuthorization(
        completeInput(config, { callback: { code: 'code-1', state: 'wrong' } })
      )
    ).rejects.toMatchObject({ code: 'state_mismatch' });
    await expect(
      completeWecomAuthorization(
        completeInput(config, { callback: { state: tx.state, error: 'access_denied' } })
      )
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('缺 code 时拒绝', async () => {
    const config = wecomConfig();
    await expect(
      completeWecomAuthorization(completeInput(config, { callback: { state: tx.state } }))
    ).rejects.toMatchObject({ code: 'code_missing' });
  });

  it('配置缺失时拒绝', async () => {
    const config = wecomConfig({ corpId: '', agentId: '', secret: '' });
    await expect(completeWecomAuthorization(completeInput(config))).rejects.toMatchObject({
      code: 'wecom_config_missing',
    });
  });

  it('非企业成员（只有 openid）fail closed', async () => {
    const config = wecomConfig();
    const { fetchImpl, urls } = routeFetch({ userinfo: { errcode: 0, openid: 'open-1' } });
    await expect(
      completeWecomAuthorization(completeInput(config), { fetch: fetchImpl })
    ).rejects.toMatchObject({ code: 'wecom_not_member' });
    expect(urls.some((url) => url.includes('/cgi-bin/user/get'))).toBe(false);
  });

  it('登录限制不命中时拒绝', async () => {
    const config = wecomConfig();
    const { fetchImpl } = routeFetch({
      userinfo: { errcode: 0, userid: 'u1', user_ticket: 'ticket' },
      detail: { errcode: 0, name: '张三', email: 'zhang@example.edu' },
    });
    const input = completeInput(config);
    const restricted = {
      ...input.config,
      auth: {
        ...input.config.auth,
        restrict: {
          enabled: true,
          conditions: [{ field: 'name' as const, path: '', value: '李四' }],
        },
      },
    };
    await expect(
      completeWecomAuthorization({ ...input, config: restricted }, { fetch: fetchImpl })
    ).rejects.toMatchObject({ code: 'login_restricted' });
  });

  it('userid 含斜杠时保留 sub，派生邮箱归一为连字符', async () => {
    const config = wecomConfig();
    const { fetchImpl } = routeFetch({
      userinfo: { errcode: 0, userid: 'CorpId/u-1001' },
      user: { errcode: 0 },
    });
    const identity = await completeWecomAuthorization(completeInput(config), { fetch: fetchImpl });
    expect(identity.sub).toBe('CorpId/u-1001');
    expect(identity.email).toBe('CorpId-u-1001@school.local');
    expect(identity.name).toBe('CorpId/u-1001');
  });

  it('登录限制可按 corp_id 自定义路径命中（设置页示例字段可用）', async () => {
    const config = wecomConfig({ corpId: 'ww-allowed' });
    const { fetchImpl } = routeFetch({
      userinfo: { errcode: 0, userid: 'u1' },
      user: { errcode: 0 },
    });
    const input = completeInput(config);
    const restricted = {
      ...input.config,
      auth: {
        ...input.config.auth,
        restrict: {
          enabled: true,
          conditions: [
            { field: 'custom' as const, path: 'corp_id', value: 'ww-allowed' },
          ],
        },
      },
    };
    const identity = await completeWecomAuthorization(
      { ...input, config: restricted },
      { fetch: fetchImpl }
    );
    expect(identity.sub).toBe('u1');
  });
});
