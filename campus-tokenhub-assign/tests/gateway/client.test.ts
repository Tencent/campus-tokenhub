import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import {
  GatewayError,
  createGatewayClient,
  readSetCookie,
} from '@/lib/gateway/client';

const PASSWORD = 'super-secret-admin-pw';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: PASSWORD,
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

type Recorded = { url: string; init: RequestInit };

/** 记录请求并按顺序返回预设响应 */
function scriptedFetch(responses: (Response | (() => Promise<Response>))[]) {
  const calls: Recorded[] = [];
  let index = 0;

  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (typeof next === 'function') return next();
    return next;
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const loginOk = () =>
  new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'set-cookie': 'admin_session=sess-1; Path=/; HttpOnly' },
  });

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
});

afterEach(() => {
  delete process.env.OCTAFUSE_ADMIN_BASE;
  delete process.env.OCTAFUSE_PROXY_BASE;
  resetConfigCache();
});

describe('readSetCookie', () => {
  it('从 Set-Cookie 里取出指定 Cookie 的值', () => {
    const response = new Response('', { headers: { 'set-cookie': 'admin_session=abc123; Path=/; HttpOnly' } });
    expect(readSetCookie(response, 'admin_session')).toBe('abc123');
    expect(readSetCookie(response, 'other')).toBeNull();
  });
});

describe('admin 通道', () => {
  it('首次调用先登录换会话 Cookie，再带 Cookie 请求业务接口', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      loginOk(),
      json({ success: true, data: [{ id: 'u-1' }] }),
    ]);

    const client = createGatewayClient({ fetchImpl });
    const result = await client.admin<{ data: { id: string }[] }>('/api/admin/users');

    expect(result.data[0].id).toBe('u-1');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('http://gateway.test:8789/api/auth/login');
    expect(String(calls[0].init.method)).toBe('POST');
    expect(calls[1].url).toBe('http://gateway.test:8789/api/admin/users');

    const headers = calls[1].init.headers as Record<string, string>;
    expect(headers.cookie).toBe('admin_session=sess-1');
  });

  it('会话 Cookie 在进程内复用，不重复登录', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      loginOk(),
      json({ success: true, data: [] }),
      json({ success: true, data: [] }),
    ]);

    const client = createGatewayClient({ fetchImpl });
    await client.admin('/api/admin/users');
    await client.admin('/api/admin/users');

    expect(calls.filter((call) => call.url.endsWith('/api/auth/login'))).toHaveLength(1);
  });

  it('业务接口返回 401 时重登一次并重试', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      loginOk(),
      json({ success: false, message: 'Unauthorized' }, 401),
      loginOk(),
      json({ success: true, data: [] }),
    ]);

    const client = createGatewayClient({ fetchImpl });
    const result = await client.admin<{ success: boolean }>('/api/admin/users');

    expect(result.success).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.filter((call) => call.url.endsWith('/api/auth/login'))).toHaveLength(2);
  });

  it('非 2xx 抛 GatewayError，带 status 与网关 message', async () => {
    const { fetchImpl } = scriptedFetch([
      loginOk(),
      json({ success: false, message: '用户不存在' }, 404),
    ]);

    const client = createGatewayClient({ fetchImpl });

    await expect(client.admin('/api/admin/users/nope')).rejects.toMatchObject({
      name: 'GatewayError',
      status: 404,
      message: '用户不存在',
    });
  });

  it('超时抛可识别错误', async () => {
    const { fetchImpl } = scriptedFetch([
      loginOk(),
      () => new Promise<Response>(() => {}),
    ]);

    const client = createGatewayClient({ fetchImpl, timeoutMs: 10 });

    await expect(client.admin('/api/admin/users')).rejects.toMatchObject({
      code: 'timeout',
      status: 0,
    });
  });

  it('错误对象里不出现管理员密码或会话 Cookie 值', async () => {
    const { fetchImpl } = scriptedFetch([
      loginOk(),
      json({ success: false, message: 'boom' }, 500),
    ]);

    const client = createGatewayClient({ fetchImpl });

    let captured: unknown;
    try {
      await client.admin('/api/admin/users');
    } catch (error) {
      captured = error;
    }

    const serialized = JSON.stringify({
      message: (captured as Error).message,
      name: (captured as Error).name,
      status: (captured as GatewayError).status,
    });
    expect(serialized).not.toContain(PASSWORD);
    expect(serialized).not.toContain('sess-1');
  });

  it('登录失败直接抛 admin_login_failed，且不复述请求体', async () => {
    const { fetchImpl } = scriptedFetch([json({ success: false, message: 'bad password' }, 401)]);

    const client = createGatewayClient({ fetchImpl });

    await expect(client.admin('/api/admin/users')).rejects.toMatchObject({
      code: 'admin_login_failed',
      status: 401,
    });
  });
});

describe('public 通道', () => {
  it('走 Proxy 且不带任何凭据', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ data: [] })]);

    const client = createGatewayClient({ fetchImpl });
    await client.publicGet('/catalog/models');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gateway.test:8790/catalog/models');
    expect((calls[0].init.headers as Record<string, string>).cookie).toBeUndefined();
  });
});
