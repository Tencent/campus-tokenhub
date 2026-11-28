import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { GatewayError, createGatewayClient } from '@/lib/gateway/client';

const KEY = 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035';
const SESSION_SECRET = 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: KEY,
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET,
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

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
});

afterEach(() => {
  for (const key of Object.keys(baseEnv)) delete process.env[key];
  resetConfigCache();
});

describe('admin 通道（集成密钥 Bearer）', () => {
  it('只发一次请求，带 Bearer Key，不登录、不带 Cookie', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ success: true, data: [{ id: 'u-1' }] })]);

    const client = createGatewayClient({ fetchImpl });
    const result = await client.admin<{ data: { id: string }[] }>('/api/admin/users');

    expect(result.data[0].id).toBe('u-1');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gateway.test:8789/api/admin/users');
    expect(String(calls[0].init.method)).toBe('GET');

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(headers.cookie).toBeUndefined();
    expect(calls[0].url).not.toContain('/api/auth/login');
  });

  it('多次调用各自带 Key，不产生任何登录请求', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json({ success: true, data: [] }),
      json({ success: true, data: [] }),
    ]);

    const client = createGatewayClient({ fetchImpl });
    await client.admin('/api/admin/users');
    await client.admin('/api/admin/models');

    expect(calls).toHaveLength(2);
    expect(calls.filter((call) => call.url.endsWith('/api/auth/login'))).toHaveLength(0);
    for (const call of calls) {
      expect((call.init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it('写请求带 JSON body、content-type 与 query', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ success: true })]);

    const client = createGatewayClient({ fetchImpl });
    await client.admin('/api/admin/keys', {
      method: 'POST',
      body: { user_id: 'u-1', name: 'main' },
      query: { page: 1, empty: '' },
    });

    const call = calls[0];
    expect(new URL(call.url).searchParams.get('page')).toBe('1');
    expect(new URL(call.url).searchParams.has('empty')).toBe(false);
    expect(String(call.init.method)).toBe('POST');
    expect((call.init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(JSON.parse(String(call.init.body))).toEqual({ user_id: 'u-1', name: 'main' });
  });

  it('401 直接抛错，不再重登重试', async () => {
    const { fetchImpl, calls } = scriptedFetch([
      json({ success: false, message: 'Unauthorized' }, 401),
      json({ success: true, data: [] }),
    ]);

    const client = createGatewayClient({ fetchImpl });

    await expect(client.admin('/api/admin/users')).rejects.toMatchObject({
      name: 'GatewayError',
      status: 401,
    });
    expect(calls).toHaveLength(1);
  });

  it('403 权限不足原样透出状态码', async () => {
    const { fetchImpl } = scriptedFetch([
      json({ success: false, message: 'Forbidden', required_permission: 'providers.secrets.read' }, 403),
    ]);

    const client = createGatewayClient({ fetchImpl });

    await expect(client.admin('/api/admin/providers/p-1/api-key')).rejects.toMatchObject({
      status: 403,
      message: 'Forbidden',
    });
  });

  it('非 2xx 抛 GatewayError，带 status 与网关 message', async () => {
    const { fetchImpl } = scriptedFetch([
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
    const { fetchImpl } = scriptedFetch([() => new Promise<Response>(() => {})]);

    const client = createGatewayClient({ fetchImpl, timeoutMs: 10 });

    await expect(client.admin('/api/admin/users')).rejects.toMatchObject({
      code: 'timeout',
      status: 0,
    });
  });

  it('错误对象里不出现集成密钥明文', async () => {
    const { fetchImpl } = scriptedFetch([
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
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain('admin_session');
  });
});

describe('public 通道', () => {
  it('走 Proxy 且不带任何凭据', async () => {
    const { fetchImpl, calls } = scriptedFetch([json({ data: [] })]);

    const client = createGatewayClient({ fetchImpl });
    await client.publicGet('/catalog/models');

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://gateway.test:8790/catalog/models');
    expect((calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
  });
});
