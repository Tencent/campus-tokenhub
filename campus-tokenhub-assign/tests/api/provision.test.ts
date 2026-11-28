import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { signSession, verifySession } from '@/lib/auth/session';

const mocks = vi.hoisted(() => ({
  provisionUser: vi.fn(),
  getUser: vi.fn(),
  getCatalog: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/gateway/users', () => ({
  provisionUser: mocks.provisionUser,
  getUser: mocks.getUser,
  findByExternalId: vi.fn(),
}));

vi.mock('@/lib/gateway/catalog', () => ({
  getCatalog: mocks.getCatalog,
  resetCatalogCache: vi.fn(),
  resolveModelPrice: vi.fn(),
  formatPricing: vi.fn(),
  formatYuan: vi.fn(),
  findModel: vi.fn(),
  CATALOG_TTL_MS: 60000,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: mocks.audit };
});

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

const identity = { sub: 'student-1', email: 'a@school.edu', name: '张三' };

async function request(
  octafuseUserId: string | null = null,
  admin = false
): Promise<Request> {
  const token = await signSession({ ...identity, octafuseUserId, admin });
  return new Request('http://portal.test/api/portal/provision', {
    method: 'POST',
    headers: { cookie: `portal_session=${token}`, origin: 'http://portal.test', host: 'portal.test' },
  });
}

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
  vi.clearAllMocks();
  vi.resetModules();
});

describe('POST /api/portal/provision', () => {
  it('开户成功后重签会话并写入新的 octafuse_user_id', async () => {
    mocks.provisionUser.mockResolvedValue({ ok: true, octafuseUserId: 'gw-9' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request(null));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, octafuse_user_id: 'gw-9' });

    const setCookie = response.headers.get('set-cookie') ?? '';
    const token = setCookie.split(';')[0].replace('portal_session=', '');
    await expect(verifySession(token)).resolves.toMatchObject({ octafuse_user_id: 'gw-9' });
  });

  it('开户失败返回 502 并写失败审计', async () => {
    mocks.provisionUser.mockResolvedValue({ ok: false, error: 'gateway down' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request(null));

    expect(response.status).toBe(502);
    expect(mocks.audit).toHaveBeenCalledWith('provision.fail', expect.anything());
  });

  it('失败审计带上网关的真实原因（否则只有一句 result=fail）', async () => {
    mocks.provisionUser.mockResolvedValue({ ok: false, error: '网关管理员登录失败' });
    const { POST } = await import('@/app/api/portal/provision/route');

    await POST(await request(null));

    expect(mocks.audit).toHaveBeenCalledWith(
      'provision.fail',
      expect.objectContaining({ detail: '网关管理员登录失败', result: 'fail' })
    );
  });

  it('管理员失败时响应体带 reason 与 request_id（排障靠这两个字段）', async () => {
    mocks.provisionUser.mockResolvedValue({ ok: false, error: '网关管理员登录失败' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request(null, true));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: 'provision_failed', reason: '网关管理员登录失败' });
    expect(body.request_id).toBeTruthy();
    expect(response.headers.get('x-request-id')).toBe(body.request_id);
  });

  it('非管理员失败时不把网关原文透出去', async () => {
    mocks.provisionUser.mockResolvedValue({ ok: false, error: 'connect ECONNREFUSED gateway-admin:8789' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request(null, false));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body.reason).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('已开户时返回当前状态，不重复开户', async () => {
    mocks.getUser.mockResolvedValue({ id: 'gw-1', status: 'active' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request('gw-1'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ octafuse_user_id: 'gw-1', status: 'active' });
    expect(mocks.provisionUser).not.toHaveBeenCalled();
  });

  it('重签会话保留管理员的 admin 声明（回归）', async () => {
    // 管理员判定改为数据库名单：把该身份放进名单。
    // 本文件 beforeEach 调了 vi.resetModules()，必须用重置后的模块实例注入，否则 override 落在旧实例上。
    const { clearAdminRoster, stubAdminRoster } = await import('../helpers/admin-roster');
    stubAdminRoster([identity.sub]);
    mocks.provisionUser.mockResolvedValue({ ok: true, octafuseUserId: 'gw-9' });
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(await request(null, true));

    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    const token = setCookie.split(';')[0].replace('portal_session=', '');
    await expect(verifySession(token)).resolves.toMatchObject({
      octafuse_user_id: 'gw-9',
      admin: true,
    });
    clearAdminRoster();
  });

  it('未登录返回 401', async () => {
    const { POST } = await import('@/app/api/portal/provision/route');

    const response = await POST(
      new Request('http://portal.test/api/portal/provision', {
        method: 'POST',
        headers: { host: 'portal.test' },
      })
    );

    expect(response.status).toBe(401);
  });
});

describe('GET /api/health', () => {
  it('目录可达时 gateway:true', async () => {
    mocks.getCatalog.mockResolvedValue({ models: [], stale: false, fetchedAt: Date.now() });
    vi.resetModules();
    const { GET } = await import('@/app/api/health/route');

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', gateway: true });
  });

  it('目录不可达时 gateway:false，但 HTTP 仍是 200', async () => {
    mocks.getCatalog.mockRejectedValue(new Error('connect ECONNREFUSED'));
    vi.resetModules();
    const { GET } = await import('@/app/api/health/route');

    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', gateway: false });
  });
});
