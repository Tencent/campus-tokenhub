import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { resetConfigCache } from '@/lib/config';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'pw',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
  // 限流桶按客户端 IP 区分，这里显式信任测试传入的 X-Forwarded-For
  TRUST_PROXY_HEADERS: 'true',
};

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  delete process.env.PUBLIC_BASE_URL;
  resetConfigCache();
});

function request(path: string, ip: string): NextRequest {
  return new NextRequest(new URL(path, 'http://portal.test'), {
    headers: { 'x-forwarded-for': ip },
  });
}

/** 连打 n 次，返回各次状态码 */
async function statuses(path: string, ip: string, times: number): Promise<number[]> {
  const result: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const response = await proxy(request(path, ip));
    result.push(response.status);
  }
  return result;
}

describe('proxy 认证端点独立限流', () => {
  it('/api/auth/password 第 21 次返回 429 并带 retry-after', async () => {
    const codes = await statuses('/api/auth/password', '198.51.100.11', 21);

    expect(codes.slice(0, 20).every((code) => code !== 429)).toBe(true);
    expect(codes[20]).toBe(429);

    const blocked = await proxy(request('/api/auth/password', '198.51.100.11'));
    expect(blocked.headers.get('retry-after')).toBe('60');
  });

  it('/api/auth/callback 放宽到 60 次，第 61 次才 429', async () => {
    const codes = await statuses('/api/auth/callback', '198.51.100.12', 61);

    expect(codes.slice(0, 60).every((code) => code !== 429)).toBe(true);
    expect(codes[60]).toBe(429);
  });

  it('两个桶互不占用：password 打满后 callback 仍放行', async () => {
    await statuses('/api/auth/password', '198.51.100.13', 21);

    const callback = await proxy(request('/api/auth/callback', '198.51.100.13'));
    expect(callback.status).not.toBe(429);
  });

  it('/api/auth/check 不受认证桶限制（管理台每次加载都会调）', async () => {
    const codes = await statuses('/api/auth/check', '198.51.100.14', 61);

    expect(codes.every((code) => code !== 429)).toBe(true);
  });

  it('不同 IP 各自计数', async () => {
    await statuses('/api/auth/password', '198.51.100.15', 21);

    const other = await proxy(request('/api/auth/password', '198.51.100.16'));
    expect(other.status).not.toBe(429);
  });
});
