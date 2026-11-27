import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'pw',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  delete process.env.PUBLIC_BASE_URL;
  resetConfigCache();
});

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  resetConfigCache();
});

type NextRequestInit = ConstructorParameters<typeof NextRequest>[1];

function request(path: string, init: NextRequestInit = {}): NextRequest {
  return new NextRequest(new URL(path, 'http://portal.test'), init);
}

describe('middleware 安全响应头', () => {
  it('未登录访问 API 返回 401，并带上防嵌套 / 防嗅探头', async () => {
    const response = await proxy(request('/api/portal/keys'));

    expect(response.status).toBe(401);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('未登录访问页面 302 到登录页并保留 next', async () => {
    const response = await proxy(request('/keys'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/login?next=%2Fkeys');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('已登录访问门户 API 放行', async () => {
    const token = await signSession({
      sub: 'u1',
      email: 'a@school.edu',
      name: '张三',
    });

    const response = await proxy(
      request('/api/portal/keys', { headers: { cookie: `portal_session=${token}` } })
    );

    expect(response.status).toBe(200);
  });

  it('同名 Cookie 并存时逐个验签（旧密钥那个排在前面也放行）', async () => {
    const token = await signSession({ sub: 'u1', email: 'a@school.edu', name: '张三' });
    const stale = 'portal_session=eyJhbGciOiJIUzI1NiJ9.stale.signature';

    expect((await proxy(request('/api/portal/keys', {
      headers: { cookie: `${stale}; portal_session=${token}` },
    }))).status).toBe(200);
    expect((await proxy(request('/keys', {
      headers: { cookie: `${stale}; portal_session=${token}` },
    }))).status).toBe(200);
  });

  it('同名 Cookie 全部无效时仍按未登录处理', async () => {
    const response = await proxy(
      request('/api/portal/keys', {
        headers: { cookie: 'portal_session=bad.one; portal_session=bad.two' },
      })
    );
    expect(response.status).toBe(401);
  });
});

/**
 * Referrer-Policy 的分档：页面 `same-origin`，接口 `no-referrer`。
 *
 * 全站 `no-referrer` 时 Chrome 会把**表单 POST** 的 `Origin` 置成 `null`，
 * `assertSameOrigin` 一律拒绝 → 侧边栏「退出登录」403「来源校验失败」。
 * 之前只给登录页放宽，已登录页面上的表单照样挂，这里锁住「所有文档响应都要放宽」。
 */
describe('Referrer-Policy 分档', () => {
  async function signedCookie(): Promise<string> {
    const token = await signSession({ sub: 'u1', email: 'a@school.edu', name: '张三' });
    return `portal_session=${token}`;
  }

  it('已登录的页面响应放宽到 same-origin', async () => {
    const response = await proxy(
      request('/settings', { headers: { cookie: await signedCookie() } })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('登录页同样是 same-origin（原生表单登录）', async () => {
    const response = await proxy(request('/login'));

    expect(response.headers.get('referrer-policy')).toBe('same-origin');
  });

  it('接口响应仍保持 no-referrer', async () => {
    const response = await proxy(request('/api/health'));

    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
});

/**
 * 域名迁移：老域名请求要在会话校验之前就跳到新域名，
 * 路径/query 原样保留；配置没切时不跳，避免死循环。
 */
describe('老域名跳转', () => {
  it('老域名 308 到 PUBLIC_BASE_URL 的域名，保留路径与 query', async () => {
    process.env.PUBLIC_BASE_URL = 'https://zhiqi.woa.com/tokenhub/member';
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/member/members?from=old', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://zhiqi.woa.com/tokenhub/member/members?from=old');
  });

  it('新域名访问不触发跳转', async () => {
    process.env.PUBLIC_BASE_URL = 'https://zhiqi.woa.com/tokenhub/member';
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/member/members', { headers: { host: 'zhiqi.woa.com' } })
    );

    // 未登录 → 登录页（307），而不是域名跳转
    expect(response.status).toBe(307);
  });

  it('PUBLIC_BASE_URL 还指向老域名时不跳，避免循环', async () => {
    process.env.PUBLIC_BASE_URL = 'https://api.aiedu.tencent.com/tokenhub/member';
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/member/members', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    expect(response.status).toBe(307);
  });
});
