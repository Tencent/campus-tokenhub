import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';
import { GatewayError } from '@/lib/gateway/client';

const mocks = vi.hoisted(() => ({
  listKeys: vi.fn(),
  createKey: vi.fn(),
  hasActiveKey: vi.fn(),
  revokeKey: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('@/lib/gateway/keys', () => ({
  listKeys: mocks.listKeys,
  createKey: mocks.createKey,
  hasActiveKey: mocks.hasActiveKey,
  revokeKey: mocks.revokeKey,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: mocks.audit };
});

import { POST } from '@/app/api/portal/keys/route';
import { DELETE } from '@/app/api/portal/keys/[id]/route';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Gateway-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

const identity = { sub: 'student-1', email: 'a@school.edu', name: '张三' };

async function request(
  method: string,
  octafuseUserId: string | null = 'gw-1',
  headers: Record<string, string> = {}
): Promise<Request> {
  const token = await signSession({ ...identity, octafuseUserId });
  return new Request('http://portal.test/api/portal/keys', {
    method,
    headers: { cookie: `portal_session=${token}`, origin: 'http://portal.test', host: 'portal.test', ...headers },
  });
}

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
  vi.clearAllMocks();
  // 默认：当前用户拥有一把 id=key-1 的密钥。DELETE 归属校验依赖它
  mocks.listKeys.mockResolvedValue([
    { id: 'key-1', key: 'sk-1', name: null, status: 'active', last_used_at: null, created_at: null },
  ]);
});

describe('POST /api/portal/keys', () => {
  it('没有 active 密钥时创建成功并返回明文', async () => {
    mocks.hasActiveKey.mockResolvedValue(false);
    mocks.createKey.mockResolvedValue({ key: 'sk-new', keyId: 'key-1' });

    const response = await POST(await request('POST'));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ key: 'sk-new', key_id: 'key-1' });
    expect(mocks.createKey).toHaveBeenCalledWith('gw-1', 'student-student-1');
  });

  it('已有 active 密钥返回 409 且不去建', async () => {
    mocks.hasActiveKey.mockResolvedValue(true);

    const response = await POST(await request('POST'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'key_exists' });
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it('会话里没有网关用户 ID 时返回 409', async () => {
    const response = await POST(await request('POST', null));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_provisioned' });
  });

  it('网关创建失败返回 502，响应体不含 key 字段', async () => {
    mocks.hasActiveKey.mockResolvedValue(false);
    mocks.createKey.mockRejectedValue(new GatewayError('upstream 500', 500));

    const response = await POST(await request('POST'));
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: 'key_create_failed' });
    expect(JSON.stringify(body)).not.toContain('sk-');
  });

  it('未登录返回 401', async () => {
    const response = await POST(
      new Request('http://portal.test/api/portal/keys', { method: 'POST', headers: { host: 'portal.test' } })
    );

    expect(response.status).toBe(401);
  });

  it('跨站 Origin 返回 403', async () => {
    const response = await POST(await request('POST', 'gw-1', { origin: 'https://evil.example.com' }));

    expect(response.status).toBe(403);
    expect(mocks.createKey).not.toHaveBeenCalled();
  });

  it('GET 调写接口返回 405', async () => {
    const response = await POST(await request('GET'));

    expect(response.status).toBe(405);
  });

  it('创建成功后写审计，且不写明文', async () => {
    mocks.hasActiveKey.mockResolvedValue(false);
    mocks.createKey.mockResolvedValue({ key: 'sk-secret-value-123456', keyId: 'key-1' });

    await POST(await request('POST'));

    expect(mocks.audit).toHaveBeenCalledWith('key.create', expect.objectContaining({ target: 'key-1' }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain('sk-secret-value-123456');
  });
});

describe('DELETE /api/portal/keys/[id]', () => {
  it('透传 keyId 并返回成功', async () => {
    mocks.revokeKey.mockResolvedValue({ alreadyGone: false });

    const response = await DELETE(await request('DELETE'), { params: Promise.resolve({ id: 'key-1' }) });

    expect(response.status).toBe(200);
    expect(mocks.revokeKey).toHaveBeenCalledWith('key-1');
  });

  it('404（已不存在）也算成功', async () => {
    mocks.revokeKey.mockResolvedValue({ alreadyGone: true });

    const response = await DELETE(await request('DELETE'), { params: Promise.resolve({ id: 'key-1' }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ already_gone: true });
  });

  it('网关异常返回 502', async () => {
    mocks.revokeKey.mockRejectedValue(new GatewayError('boom', 500));

    const response = await DELETE(await request('DELETE'), { params: Promise.resolve({ id: 'key-1' }) });

    expect(response.status).toBe(502);
  });

  it('C2：吊销不属于自己的密钥返回 404，且不调用 revokeKey', async () => {
    const response = await DELETE(await request('DELETE'), {
      params: Promise.resolve({ id: 'other-students-key' }),
    });

    expect(response.status).toBe(404);
    expect(mocks.revokeKey).not.toHaveBeenCalled();
    expect(mocks.listKeys).toHaveBeenCalledWith('gw-1');
  });

  it('C2：自己的密钥按归属校验通过后才吊销', async () => {
    mocks.revokeKey.mockResolvedValue({ alreadyGone: false });

    const response = await DELETE(await request('DELETE'), { params: Promise.resolve({ id: 'key-1' }) });

    expect(response.status).toBe(200);
    expect(mocks.revokeKey).toHaveBeenCalledWith('key-1');
  });
});
