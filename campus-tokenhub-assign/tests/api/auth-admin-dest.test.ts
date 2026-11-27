import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetConfigCache } from '@/lib/config';

const mocks = vi.hoisted(() => ({
  provisionUser: vi.fn(),
  shouldForceSetup: vi.fn(),
  audit: vi.fn(),
  start: vi.fn(),
  complete: vi.fn(),
}));

vi.mock('@/lib/gateway/users', () => ({
  provisionUser: mocks.provisionUser,
  getUser: vi.fn(),
  findByExternalId: vi.fn(),
}));

vi.mock('@/lib/onboarding/access', () => ({
  shouldForceSetup: mocks.shouldForceSetup,
}));

// 登录路由/回调会用 cookies() 读「上次所在模式」，测试环境没有请求上下文，固定回退首页
vi.mock('@/lib/portal/mode-cookie', () => ({
  readPortalModeHome: async () => '/overview',
  readPortalMode: async () => 'assign',
  PORTAL_MODE_COOKIE: 'portal_mode',
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: mocks.audit };
});

vi.mock('@/lib/auth/providers/registry', () => ({
  getAuthAdapter: () => ({
    kind: 'aie',
    requiresRedirect: true,
    label: '使用学校账号登录',
    start: mocks.start,
    complete: mocks.complete,
  }),
  authErrorCode: () => 'login_failed',
}));

const SECRET = 'unit-test-secret-that-is-long-enough';

function setEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
    OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
    OCTAFUSE_ADMIN_USERNAME: 'admin',
    OCTAFUSE_ADMIN_PASSWORD: 'pw',
    OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
    SESSION_SECRET: SECRET,
    ...overrides,
  });
  resetConfigCache();
}

beforeEach(() => {
  delete process.env.ADMIN_PUBLIC_BASE_URL;
  delete process.env.PUBLIC_BASE_URL;
  setEnv();
  vi.clearAllMocks();
  vi.resetModules();
  mocks.start.mockResolvedValue('https://idp.test/authorize?state=s');
  mocks.provisionUser.mockResolvedValue({ ok: true, octafuseUserId: 'gw-1' });
  mocks.shouldForceSetup.mockResolvedValue(false);
  mocks.complete.mockResolvedValue({ sub: 't-1', email: 'teacher@school.edu', name: '李老师' });
});

async function readTx(token: string) {
  const { verifyOidcTx } = await import('@/lib/auth/providers/oidc');
  return verifyOidcTx(token, SECRET);
}

describe('GET /api/auth/login?dest=admin', () => {
  it('把管理台目标写进登录事务，next 不被当成门户站内路径', async () => {
    const { GET } = await import('@/app/api/auth/login/route');

    const response = await GET(
      new NextRequest(
        'http://portal.test/api/auth/login?dest=admin&next=%2Fgateway%2Fusers%2F1%3Ftab%3Dkeys'
      )
    );

    expect(response.status).toBe(303);
    const cookie = response.cookies.get('oidc_tx');
    const tx = await readTx(cookie!.value);
    expect(tx).toMatchObject({
      dest: 'admin',
      adminNext: '/gateway/users/1?tab=keys',
      next: '/overview',
    });
  });

  it('不带 dest 时保持门户语义（next 仍按站内路径收敛）', async () => {
    const { GET } = await import('@/app/api/auth/login/route');

    const response = await GET(
      new NextRequest('http://portal.test/api/auth/login?next=%2Fmembers')
    );

    const tx = await readTx(response.cookies.get('oidc_tx')!.value);
    expect(tx).toMatchObject({ next: '/members' });
    expect(tx?.dest).toBeUndefined();
  });

  it('dest=admin 时非法 next 被收敛为根路径', async () => {
    const { GET } = await import('@/app/api/auth/login/route');

    const response = await GET(
      new NextRequest('http://portal.test/api/auth/login?dest=admin&next=%2F%2Fevil.example')
    );

    const tx = await readTx(response.cookies.get('oidc_tx')!.value);
    expect(tx).toMatchObject({ dest: 'admin', adminNext: '/' });
  });
});

describe('GET /api/auth/callback?dest=admin', () => {
  async function callbackRequest(tx: { next: string; dest?: 'admin'; adminNext?: string }) {
    const { OIDC_TX_COOKIE, createOidcTx, signOidcTx } = await import('@/lib/auth/providers/oidc');
    const base = await createOidcTx(tx.next);
    const signed = await signOidcTx({ ...base, ...tx }, SECRET);
    return new NextRequest('http://portal.test/api/auth/callback?code=c&state=' + base.state, {
      headers: { cookie: `${OIDC_TX_COOKIE}=${signed}`, host: 'portal.test' },
    });
  }

  it('回到管理台深链接，且不跳门户 /setup', async () => {
    setEnv({ ADMIN_PUBLIC_BASE_URL: 'https://api.example.com/tokenhub/admin' });
    mocks.shouldForceSetup.mockResolvedValue(true);
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(
      await callbackRequest({ next: '/overview', dest: 'admin', adminNext: '/gateway/users/1?tab=keys' })
    );

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      'https://api.example.com/tokenhub/admin/gateway/users/1?tab=keys'
    );
    expect(mocks.shouldForceSetup).not.toHaveBeenCalled();
  });

  it('管理台基址缺失时返回 500 可读错误页，不产生 302', async () => {
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(
      await callbackRequest({ next: '/overview', dest: 'admin', adminNext: '/gateway/users/1' })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get('location')).toBeNull();
    await expect(response.text()).resolves.toContain('ADMIN_PUBLIC_BASE_URL');
  });

  it('不带 dest 时沿用门户逻辑（含 forceSetup）', async () => {
    mocks.shouldForceSetup.mockResolvedValue(true);
    const { GET } = await import('@/app/api/auth/callback/route');

    const response = await GET(await callbackRequest({ next: '/members' }));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://portal.test/setup');
  });
});
