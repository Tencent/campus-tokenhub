import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';

const SESSION_SECRET = 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Gateway-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET,
};

/**
 * 用 `vi.stubEnv` 而不是直接 `Object.assign(process.env, ...)`：
 * 直接写 env **不会在测试结束后还原**，全量并发跑时会把 SESSION_SECRET 泄漏给
 * 同 worker 的下一个测试文件。本文件里「同名 Cookie 逐个验签」那个用例要跨
 * 「签名」和「middleware 验签」两次读 config，一旦前后 secret 不一致，
 * 就会偶发表现为「登录态被判无效」。
 */
beforeEach(() => {
  for (const [key, value] of Object.entries(baseEnv)) vi.stubEnv(key, value);
  vi.stubEnv('PUBLIC_BASE_URL', '');
  resetConfigCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
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
    // 显式传 secret：让签名不依赖 config 缓存的当前状态（middleware 侧仍读 config）
    const token = await signSession(
      {
        sub: 'u1',
        email: 'a@school.edu',
        name: '张三',
        octafuseUserId: 'gw-1',
      },
      { secret: SESSION_SECRET }
    );

    const response = await proxy(
      request('/api/portal/keys', { headers: { cookie: `portal_session=${token}` } })
    );

    expect(response.status).toBe(200);
  });

  it('同名 Cookie 并存时逐个验签（旧密钥那个排在前面也放行）', async () => {
    // 浏览器允许同名不同 Path 的 Cookie 并存：升级后常出现「旧 Cookie 排在前面」。
    // 只看第一个会表现为「登录成功、但每个接口都 401」，这里锁住逐个验签的行为。
    // 显式传 secret：让签名不依赖 config 缓存的当前状态（middleware 侧仍读 config）
    const token = await signSession(
      {
        sub: 'u1',
        email: 'a@school.edu',
        name: '张三',
        octafuseUserId: 'gw-1',
      },
      { secret: SESSION_SECRET }
    );
    const stale = 'portal_session=eyJhbGciOiJIUzI1NiJ9.stale.signature';

    expect((await proxy(request('/api/portal/keys', {
      headers: { cookie: `${stale}; portal_session=${token}` },
    }))).status).toBe(200);
    // 页面路径同理：不该被踢回登录页
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
    const token = await signSession(
      {
        sub: 'u1',
        email: 'a@school.edu',
        name: '张三',
        octafuseUserId: 'gw-1',
      },
      { secret: SESSION_SECRET }
    );
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
    vi.stubEnv('PUBLIC_BASE_URL', 'https://zhiqi.woa.com/tokenhub/portal');
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/portal/keys?from=old', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://zhiqi.woa.com/tokenhub/portal/keys?from=old');
  });

  it('新域名访问不触发跳转', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://zhiqi.woa.com/tokenhub/portal');
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/portal/keys', { headers: { host: 'zhiqi.woa.com' } })
    );

    // 未登录 → 登录页（307），而不是域名跳转
    expect(response.status).toBe(307);
  });

  it('PUBLIC_BASE_URL 还指向老域名时不跳，避免循环', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://api.aiedu.tencent.com/tokenhub/portal');
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/portal/keys', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    expect(response.status).toBe(307);
  });

  it('老域名的模型代理接口不跳转', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://zhiqi.woa.com/tokenhub/portal');
    resetConfigCache();

    // 学生端 base_url 已固化成老域名的 /tokenhub/v1，跳走等于让存量客户端失效
    const response = await proxy(
      request('/tokenhub/v1/chat/completions', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    // 没有 308 域名跳转；未登录的页面路径按惯例去登录页（307）
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).not.toContain('api.aiedu.tencent.com');
  });

  it('老域名的同名非边界路径仍整站跳转', async () => {
    vi.stubEnv('PUBLIC_BASE_URL', 'https://zhiqi.woa.com/tokenhub/portal');
    resetConfigCache();

    const response = await proxy(
      request('/tokenhub/v10/models', { headers: { host: 'api.aiedu.tencent.com' } })
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://zhiqi.woa.com/tokenhub/v10/models');
  });
});
