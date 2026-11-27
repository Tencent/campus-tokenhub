import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
  authCallbackUrl: vi.fn(),
  createOidcTx: vi.fn(),
  signOidcTx: vi.fn(),
  buildOidcTxCookie: vi.fn(),
}));

vi.mock('@/lib/config', () => ({ getConfig: mocks.getConfig }));

vi.mock('@/lib/auth/login', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/login')>();
  return { ...actual, authCallbackUrl: mocks.authCallbackUrl };
});

vi.mock('@/lib/auth/providers/oidc', () => ({
  OIDC_TX_COOKIE: 'oidc_tx',
  createOidcTx: mocks.createOidcTx,
  signOidcTx: mocks.signOidcTx,
  buildOidcTxCookie: mocks.buildOidcTxCookie,
}));

const SECRET = 'wecom-qr-session-secret-32-chars';
const CORP_ID = 'wwCorp';
const AGENT_ID = '1000002';
const WECOM_SECRET = 'wecom-app-secret-never-in-response';
const REDIRECT_URI = 'https://portal.test/tokenhub/portal/api/auth/callback';

type TxCookieResponse = {
  cookies: { get: (name: string) => { value: string } | undefined };
  status: number;
};

function setConfig(overrides: {
  provider?: string;
  wecom?: Partial<Record<'corpId' | 'agentId' | 'secret' | 'scope', string>>;
} = {}): void {
  mocks.getConfig.mockReturnValue({
    auth: {
      provider: overrides.provider ?? 'wecom',
      sessionSecret: SECRET,
      cookieSecure: true,
      wecom: {
        corpId: CORP_ID,
        agentId: AGENT_ID,
        secret: WECOM_SECRET,
        scope: 'snsapi_base',
        ...overrides.wecom,
      },
    },
  });
}

function makeRequest(query = '', headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`https://portal.test/api/auth/wecom/qr${query}`, {
    headers: { host: 'portal.test', ...headers },
  });
}

async function loadGet() {
  const { GET } = await import('@/app/api/auth/wecom/qr/route');
  return GET;
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

function expectNoTxCookie(response: TxCookieResponse): void {
  expect(response.cookies.get('oidc_tx')).toBeUndefined();
}

function expectQrAvailable(response: TxCookieResponse): void {
  expect(response.status).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
  setConfig();
  mocks.authCallbackUrl.mockReturnValue(REDIRECT_URI);
  mocks.createOidcTx.mockImplementation(async (next: string) => ({
    state: `state-${next}`,
    nonce: 'nonce',
    codeVerifier: 'verifier',
    codeChallenge: 'challenge',
    next,
  }));
  mocks.signOidcTx.mockImplementation(async (tx: { state: string }) => `signed.${tx.state}`);
  mocks.buildOidcTxCookie.mockImplementation((token: string, secure: boolean) => ({
    name: 'oidc_tx',
    value: token,
    options: { httpOnly: true, sameSite: 'lax', path: '/', secure, maxAge: 600 },
  }));
});

describe('GET /api/auth/wecom/qr', () => {
  it('当前协议不是 wecom 时返回 400，不生成事务', async () => {
    setConfig({ provider: 'oauth2' });
    const GET = await loadGet();

    const response = await GET(makeRequest('', { origin: 'https://portal.test' }));

    expect(response.status).toBe(400);
    expect(await readBody(response)).toEqual({ error: 'auth_unsafe' });
    expect(mocks.createOidcTx).not.toHaveBeenCalled();
    expectNoTxCookie(response);
  });

  it.each([
    ['CorpID', { corpId: '' }],
    ['AgentID', { agentId: '' }],
    ['Secret', { secret: '' }],
    ['空白 Secret', { secret: '   ' }],
  ])('缺少 %s 时返回 wecom_config_missing，不生成事务也不写 Cookie', async (_label, wecom) => {
    setConfig({ wecom });
    const GET = await loadGet();

    const response = await GET(makeRequest('', { origin: 'https://portal.test' }));

    expect(response.status).toBe(400);
    expect(await readBody(response)).toEqual({ error: 'wecom_config_missing' });
    expect(mocks.createOidcTx).not.toHaveBeenCalled();
    expectNoTxCookie(response);
  });

  it('Origin 与回调地址 origin 一致时返回扫码参数并写入 oidc_tx Cookie', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest('', { origin: 'https://portal.test' }));
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expectQrAvailable(response);
    expect(body).toMatchObject({
      corpId: CORP_ID,
      agentId: AGENT_ID,
      redirectUri: REDIRECT_URI,
    });
    expect(typeof body.state).toBe('string');
    expect(body.state).toBeTruthy();
    expect(body.secret).toBeUndefined();
    expect(text).not.toContain(WECOM_SECRET);
    expect(JSON.stringify([...response.headers.entries()])).not.toContain(WECOM_SECRET);
    expect(response.cookies.get('oidc_tx')?.value).toBe(`signed.${String(body.state)}`);
    expect(mocks.signOidcTx).toHaveBeenCalledWith(
      expect.objectContaining({ state: body.state }),
      SECRET
    );
    expect(mocks.buildOidcTxCookie).toHaveBeenCalledWith(`signed.${String(body.state)}`, true);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.authCallbackUrl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['null 字符串', 'null'],
    ['空字符串', ''],
  ])('Origin 为 %s 时回退到 x-forwarded-host', async (_label, origin) => {
    const GET = await loadGet();

    const response = await GET(makeRequest('', {
      origin,
      'x-forwarded-host': 'portal.test',
      host: 'evil.example',
    }));

    expectQrAvailable(response);
    expect(mocks.createOidcTx).toHaveBeenCalledTimes(1);
  });

  it('没有 Origin 与 x-forwarded-host 时用 Host（含端口）比对', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest('', { host: 'portal.test:443' }));

    expectQrAvailable(response);
    expect(mocks.createOidcTx).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Origin', { origin: 'https://evil.example', host: 'portal.test' }],
    [
      'x-forwarded-host 优先于 Host',
      { origin: 'null', 'x-forwarded-host': 'evil.example', host: 'portal.test' },
    ],
    ['Host', { origin: 'null', host: 'evil.example' }],
  ])('%s 与回调 origin 不一致时返回 wecom_qr_unavailable，不生成事务也不写 Cookie', async (_label, headers) => {
    const GET = await loadGet();

    const response = await GET(makeRequest('', headers));

    expect(response.status).toBe(400);
    expect(await readBody(response)).toEqual({ error: 'wecom_qr_unavailable' });
    expect(mocks.createOidcTx).not.toHaveBeenCalled();
    expectNoTxCookie(response);
  });

  it('门户 next 只保留站内相对路径', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest('?next=%2Fmembers%3Ftab%3Dkeys', {
      origin: 'https://portal.test',
    }));

    expectQrAvailable(response);
    expect(mocks.createOidcTx).toHaveBeenCalledWith('/members?tab=keys');
    expect(mocks.signOidcTx.mock.calls[0][0]).toMatchObject({ next: '/members?tab=keys' });
  });

  it('门户 next 为 //evil.example 时回落到站内首页', async () => {
    const { sanitizeNextPath } = await import('@/lib/auth/login');
    const GET = await loadGet();

    const response = await GET(makeRequest('?next=%2F%2Fevil.example%2Fsteal', {
      origin: 'https://portal.test',
    }));

    expectQrAvailable(response);
    expect(mocks.createOidcTx).toHaveBeenCalledWith(sanitizeNextPath('//evil.example/steal'));
    const passedNext = mocks.createOidcTx.mock.calls[0][0] as string;
    expect(passedNext).not.toContain('evil.example');
  });

  it('dest=admin 时把净化后的管理台深链接写进事务', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest('?dest=admin&next=%2Fgateway%2Fusers%2F1%3Ftab%3Dkeys', {
      origin: 'https://portal.test',
    }));

    expectQrAvailable(response);
    expect(mocks.signOidcTx.mock.calls[0][0]).toMatchObject({
      dest: 'admin',
      adminNext: '/gateway/users/1?tab=keys',
    });
  });

  it('dest=admin 时非法 next 的管理台深链接收敛为根路径', async () => {
    const GET = await loadGet();

    const response = await GET(makeRequest('?dest=admin&next=%2F%2Fevil.example', {
      origin: 'https://portal.test',
    }));

    expectQrAvailable(response);
    const tx = mocks.signOidcTx.mock.calls[0][0];
    expect(tx).toMatchObject({ dest: 'admin', adminNext: '/' });
    expect(JSON.stringify(tx)).not.toContain('evil.example');
  });
});
