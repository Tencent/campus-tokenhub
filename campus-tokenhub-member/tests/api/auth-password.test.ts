import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';
import { resetConfigCache } from '@/lib/config';
import { SESSION_COOKIE, verifySession } from '@/lib/auth/session';
import { resetPasswordRateLimit } from '@/lib/auth/password-rate-limit';

const SECRET = 'auth-password-route-test-secret-32chars';

const BASE_ENV: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'gateway-admin',
  OCTAFUSE_ADMIN_PASSWORD: 'gateway-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: SECRET,
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
};

const SSO_READY: Record<string, string> = {
  AUTH_PROVIDER: 'oauth2',
  OAUTH2_AUTHORIZATION_ENDPOINT: 'https://idp.example.com/oauth2/authorize',
  OAUTH2_TOKEN_ENDPOINT: 'https://idp.example.com/oauth2/token',
  OAUTH2_USERINFO_ENDPOINT: 'https://idp.example.com/oauth2/userinfo',
  OAUTH2_CLIENT_ID: 'client-id',
  OAUTH2_CLIENT_SECRET: 'client-secret',
};

const original = { ...process.env };

function applyEnv(extra: Record<string, string> = {}): void {
  process.env = { ...original, ...BASE_ENV, ...extra };
  resetConfigCache();
}

function formRequest(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): NextRequest {
  return new NextRequest('http://portal.test/api/auth/password', {
    method: 'POST',
    headers: {
      host: 'portal.test',
      'content-type': 'application/x-www-form-urlencoded',
      ...headers,
    },
    body: new URLSearchParams(fields).toString(),
  });
}

async function post(
  fields: Record<string, string>,
  headers: Record<string, string> = {}
): Promise<NextResponse> {
  const { POST } = await import('@/app/api/auth/password/route');
  return POST(formRequest(fields, headers));
}

const GOOD = { username: 'ops-admin', password: 'bootstrap-password-1234' };

beforeEach(() => {
  applyEnv();
  resetPasswordRateLimit();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetPasswordRateLimit();
});

describe('POST /api/auth/password', () => {
  it('口令正确：签发密码会话并落到 /settings', async () => {
    const response = await post(GOOD);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://portal.test/settings');

    const cookie = response.cookies.get(SESSION_COOKIE);
    expect(cookie).toBeDefined();
    const session = await verifySession(cookie!.value, { secret: SECRET });
    expect(session).toMatchObject({
      sub: 'local:ops-admin',
      email: 'ops-admin@local',
      admin: true,
      login_method: 'password',
      octafuse_user_id: null,
    });
  });

  it('带 next 时按站内路径跳转，非法 next 回落到 /settings', async () => {
    const ok = await post({ ...GOOD, next: '/members' });
    expect(ok.headers.get('location')).toBe('http://portal.test/members');

    resetPasswordRateLimit();
    const bad = await post({ ...GOOD, next: 'https://evil.example' });
    expect(bad.headers.get('location')).toBe('http://portal.test/settings');
  });

  it('口令错误：统一 password_invalid，不写会话', async () => {
    const response = await post({ ...GOOD, password: 'wrong-password-1234' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('/login?error=password_invalid');
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('用户名错与口令错给出同一个错误码（不可枚举账号）', async () => {
    const wrongUser = await post({ username: 'someone', password: 'bootstrap-password-1234' });
    const wrongPassword = await post({ ...GOOD, password: 'nope-nope-nope' });

    expect(wrongUser.headers.get('location')).toContain('error=password_invalid');
    expect(wrongPassword.headers.get('location')).toContain('error=password_invalid');
  });

  it('SSO 已配齐时仍然放行（配好≠调通，关不关由运维决定）', async () => {
    applyEnv(SSO_READY);

    const response = await post(GOOD);

    expect(response.headers.get('location')).not.toContain('error=');
    expect(response.cookies.get(SESSION_COOKIE)).toBeDefined();
  });

  it('PORTAL_ADMIN_LOGIN=off 时拒绝', async () => {
    applyEnv({ PORTAL_ADMIN_LOGIN: 'off' });

    const response = await post(GOOD);

    expect(response.headers.get('location')).toContain('error=password_disabled');
  });

  it('未配置凭据时给出 password_unconfigured', async () => {
    applyEnv({ PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' });

    const response = await post(GOOD);

    expect(response.headers.get('location')).toContain('error=password_unconfigured');
  });

  it('跨源 Origin 被拒，且不校验口令', async () => {
    const response = await post(GOOD, { origin: 'https://evil.example' });

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('error=origin_mismatch');
    expect(response.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });

  it('同源 Origin 正常放行', async () => {
    const response = await post(GOOD, { origin: 'http://portal.test' });

    expect(response.headers.get('location')).toBe('http://portal.test/settings');
  });

  it('连续失败达到上限后锁定，即使口令正确也拒绝', async () => {
    const bad = { ...GOOD, password: 'wrong-password-1234' };
    for (let i = 0; i < 5; i += 1) {
      await post(bad, { 'x-forwarded-for': '203.0.113.9' });
    }

    const locked = await post(GOOD, { 'x-forwarded-for': '203.0.113.9' });
    expect(locked.headers.get('location')).toContain('error=password_rate_limited');

    // 其它 IP 不受影响
    const otherIp = await post(GOOD, { 'x-forwarded-for': '203.0.113.10' });
    expect(otherIp.headers.get('location')).toBe('http://portal.test/settings');
  });

  it('成功登录会清零该 IP 的失败计数', async () => {
    const bad = { ...GOOD, password: 'wrong-password-1234' };
    await post(bad, { 'x-forwarded-for': '198.51.100.7' });
    await post(GOOD, { 'x-forwarded-for': '198.51.100.7' });
    await post(bad, { 'x-forwarded-for': '198.51.100.7' });

    const again = await post(GOOD, { 'x-forwarded-for': '198.51.100.7' });
    expect(again.headers.get('location')).toBe('http://portal.test/settings');
  });

  it('dest=admin 且配置了管理台地址时跳管理台', async () => {
    applyEnv({ ADMIN_PUBLIC_BASE_URL: 'https://api.example.com/tokenhub/admin' });

    const response = await post({ ...GOOD, dest: 'admin', next: '/users' });

    expect(response.headers.get('location')).toBe('https://api.example.com/tokenhub/admin/users');
  });
});
