import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { resetConfigCache } from '@/lib/config';
import { SESSION_COOKIE } from '@/lib/auth/session';
import { resetPasswordRateLimit } from '@/lib/auth/password-rate-limit';
import {
  emptyOverlayStored,
  ensureConfigOverlayLoaded,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';

/**
 * 埋点失败不能影响登录（统一采买站）。
 *
 * `recordLogin` 自身有 300ms 预算与内部 catch（由 `packages/portal-activity` 单测覆盖），
 * 但路由层的裸 `await` 一旦遇到意外抛错，会把已经签发的会话打成 500。这里锁死路由层
 * 的兜底：写入抛错时仍然 303 且照常下发会话 Cookie。
 */

const mocks = vi.hoisted(() => ({ recordLogin: vi.fn(), recordPageView: vi.fn() }));

vi.mock('@/lib/activity/recorder', () => ({
  activityRecorder: {
    site: 'assign',
    recordLogin: mocks.recordLogin,
    recordPageView: mocks.recordPageView,
    pruneIfDue: vi.fn(),
  },
}));

const SECRET = 'auth-login-resilience-secret-32-chars';
const original = { ...process.env };

const BASE_ENV: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: SECRET,
  PORTAL_ADMIN_USERNAME: 'ops-admin',
  PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
  TRUST_PROXY_HEADERS: 'true',
};

async function postPassword(): Promise<Response> {
  const { POST } = await import('@/app/api/auth/password/route');
  return POST(
    new NextRequest('http://portal.test/api/auth/password', {
      method: 'POST',
      headers: {
        host: 'portal.test',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        username: 'ops-admin',
        password: 'bootstrap-password-1234',
      }).toString(),
    })
  );
}

beforeEach(async () => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
  setOverlayLoader(async () => emptyOverlayStored());
  await ensureConfigOverlayLoaded(1000);
  resetPasswordRateLimit();
  mocks.recordLogin.mockReset();
  mocks.recordPageView.mockReset();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetPasswordRateLimit();
});

describe('登录埋点失败不影响登录（统一采买站）', () => {
  it('recordLogin 抛错时仍然 303、下发会话并写入 password 事件', async () => {
    mocks.recordLogin.mockRejectedValue(new Error('db down'));

    const response = await postPassword();

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('http://portal.test/settings');
    expect(response.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    expect(mocks.recordLogin).toHaveBeenCalledTimes(1);
    expect(mocks.recordLogin).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'local:ops-admin', method: 'password' })
    );
  });

  it('recordLogin 正常时同样 303 且只写一次', async () => {
    mocks.recordLogin.mockResolvedValue(undefined);

    const response = await postPassword();

    expect(response.status).toBe(303);
    expect(mocks.recordLogin).toHaveBeenCalledTimes(1);
  });
});
