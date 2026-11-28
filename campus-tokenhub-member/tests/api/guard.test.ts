import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireSession,
} from '@/lib/api/guard';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

const identity = { sub: 'student-1', email: 'a@school.edu', name: '张三', octafuseUserId: 'gw-1' };

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  delete process.env.PUBLIC_BASE_URL;
  resetConfigCache();
});

afterEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  resetConfigCache();
});

async function sessionCookie(): Promise<string> {
  const token = await signSession(identity);
  return `portal_session=${token}`;
}

function post(headers: Record<string, string> = {}): Request {
  return new Request('http://portal.test/api/portal/keys', { method: 'POST', headers });
}

describe('assertMethod', () => {
  it('允许的方法放行', () => {
    expect(() => assertMethod(post(), ['POST'])).not.toThrow();
  });

  it('GET 调写接口返回 405', () => {
    const request = new Request('http://portal.test/api/portal/keys', { method: 'GET' });
    expect(() => assertMethod(request, ['POST'])).toThrow(ApiError);
    try {
      assertMethod(request, ['POST']);
    } catch (error) {
      expect(error).toMatchObject({ status: 405 });
    }
  });
});

describe('assertSameOrigin', () => {
  it('Origin 与 Host 一致时放行', () => {
    const request = post({ origin: 'http://portal.test', host: 'portal.test' });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it('Origin 与 Host 不一致返回 403', () => {
    const request = post({ origin: 'https://evil.example.com', host: 'portal.test' });
    try {
      assertSameOrigin(request);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'origin_mismatch' });
    }
  });

  it('Origin 为 null 时拒绝', () => {
    const request = post({ origin: 'null', host: 'portal.test' });
    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });

  it('没有 Origin 头的非浏览器请求放行（curl / 服务端调用）', () => {
    expect(() => assertSameOrigin(post({ host: 'portal.test' }))).not.toThrow();
  });

  it('不信任 X-Forwarded-Host：没配 PUBLIC_BASE_URL 时仍按真实 Host 比对', () => {
    const request = post({
      origin: 'https://ai.school.edu.cn',
      host: 'portal.test',
      'x-forwarded-host': 'ai.school.edu.cn',
    });
    try {
      assertSameOrigin(request);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'origin_mismatch' });
    }
  });

  it('配置 PUBLIC_BASE_URL 后按它比对（反向代理场景）', () => {
    process.env.PUBLIC_BASE_URL = 'https://ai.school.edu.cn';
    resetConfigCache();

    const request = post({ origin: 'https://ai.school.edu.cn', host: 'gateway:3000' });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it('PUBLIC_BASE_URL 是线上域名、浏览器在 localhost 访问时按实际 Host 放行', () => {
    // 本地 docker 常态：.env 里的 PUBLIC_BASE_URL 还是线上地址，
    // 只按配置比对会把 localhost:3000 的写请求全部判成跨源（门户所有写操作 403）
    process.env.PUBLIC_BASE_URL = 'https://api.aiedu.tencent.com/tokenhub/portal';
    resetConfigCache();

    const request = post({ origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(() => assertSameOrigin(request)).not.toThrow();
  });

  it('配置 PUBLIC_BASE_URL 后，站外 Origin 仍然拒绝', () => {
    process.env.PUBLIC_BASE_URL = 'https://ai.school.edu.cn';
    resetConfigCache();

    const request = post({ origin: 'https://evil.example.com', host: 'gateway:3000' });
    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });

  it('Sec-Fetch-Site: cross-site 且没有 Origin 时拒绝（补 Origin 缺失的缺口）', () => {
    // 跨站表单在部分浏览器/代理链路上会省略 Origin，此时旧逻辑直接放行
    const request = post({ host: 'portal.test', 'sec-fetch-site': 'cross-site' });
    try {
      assertSameOrigin(request);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({ status: 403, code: 'origin_mismatch' });
    }
  });

  it('Sec-Fetch-Site: cross-site 优先于同源 Origin（矛盾时按更严格的一方拒）', () => {
    const request = post({
      origin: 'http://portal.test',
      host: 'portal.test',
      'sec-fetch-site': 'cross-site',
    });
    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });

  it('Sec-Fetch-Site: same-origin / same-site / none 不额外拦截', () => {
    for (const fetchSite of ['same-origin', 'same-site', 'none']) {
      const request = post({
        origin: 'http://portal.test',
        host: 'portal.test',
        'sec-fetch-site': fetchSite,
      });
      expect(() => assertSameOrigin(request)).not.toThrow();
    }
  });

  it('Sec-Fetch-Site: same-site 但 Origin 是别的子域，仍按 Origin 拒绝', () => {
    const request = post({
      origin: 'https://admin.portal.test',
      host: 'portal.test',
      'sec-fetch-site': 'same-site',
    });
    expect(() => assertSameOrigin(request)).toThrow(ApiError);
  });
});

describe('requireSession', () => {
  it('无 Cookie 返回 401', async () => {
    await expect(requireSession(post())).rejects.toMatchObject({ status: 401 });
  });

  it('伪造 Cookie 返回 401', async () => {
    await expect(requireSession(post({ cookie: 'portal_session=bad.token.value' }))).rejects.toMatchObject({
      status: 401,
    });
  });

  it('有效会话可通过', async () => {
    const session = await requireSession(post({ cookie: await sessionCookie() }));
    expect(session.sub).toBe(identity.sub);
  });

  it('同名 Cookie 并存时逐个验签：旧密钥那个排在前面也不影响', async () => {
    // 浏览器允许同名不同 Path 的 Cookie 并存，旧密钥签的那个可能排在前面。
    // 只取第一个会表现为「页面能进、所有写接口 401」，这里锁住逐个验签的行为。
    const stale = 'portal_session=eyJhbGciOiJIUzI1NiJ9.stale.signature';
    const fresh = await sessionCookie();
    const session = await requireSession(post({ cookie: `${stale}; ${fresh}` }));
    expect(session.sub).toBe(identity.sub);
  });

  it('全部同名 Cookie 都无效时仍 401', async () => {
    await expect(
      requireSession(post({ cookie: 'portal_session=bad.one; portal_session=bad.two' }))
    ).rejects.toMatchObject({ status: 401 });
  });

  it('ApiError 映射成对应状态码与中文消息', async () => {
    const response = jsonError(new ApiError(403, '来源校验失败', 'origin_mismatch'));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: '来源校验失败', code: 'origin_mismatch' });
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-request-id')).toBeTruthy();
  });

  it('未知错误统一 500，不泄漏内部信息', async () => {
    const response = jsonError(new Error('ECONNREFUSED 10.0.0.1:8789'));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).not.toContain('ECONNREFUSED');
  });
});
