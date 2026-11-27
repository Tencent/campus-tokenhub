import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/guard';
import { requireSession } from '@/lib/api/guard';
import { signSession } from '@/lib/auth/session';
import { resetConfigCache } from '@/lib/config';
import {
  emptyOverlayStored,
  ensureConfigOverlayLoaded,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import { storedConfig } from '../helpers/config';

const SECRET = 'password-session-test-secret-32-chars-ok';

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

/** 设置页已配齐的 SSO：运行期配置只存数据库，用 overlay 而不是 env 提供 */
const SSO_READY_FIELDS = {
  oauth2AuthorizationEndpoint: 'https://idp.example.com/oauth2/authorize',
  oauth2TokenEndpoint: 'https://idp.example.com/oauth2/token',
  oauth2UserInfoEndpoint: 'https://idp.example.com/oauth2/userinfo',
  oauth2ClientId: 'client-id',
  oauth2ClientSecret: 'client-secret',
};

const original = { ...process.env };

async function applyEnv(extra: Record<string, string> = {}, sso = false): Promise<void> {
  process.env = { ...original, ...BASE_ENV, ...extra };
  resetConfigCache();
  resetOverlayForTests();
  setOverlayLoader(async () => (sso ? storedConfig(SSO_READY_FIELDS) : emptyOverlayStored()));
  await ensureConfigOverlayLoaded(1000);
}

function requestWith(token: string): Request {
  return new Request('http://portal.test/api/portal/settings', {
    headers: { cookie: `portal_session=${token}` },
  });
}

async function passwordSession(): Promise<string> {
  return signSession({
    sub: 'local:ops-admin',
    email: 'ops-admin@local',
    name: 'ops-admin',
    octafuseUserId: null,
    admin: true,
    loginMethod: 'password',
  });
}

async function ssoSession(): Promise<string> {
  return signSession({
    sub: '100051:teacher-1',
    email: 'teacher@school.edu',
    name: '老师',
    octafuseUserId: 'gw-1',
  });
}

beforeEach(async () => {
  await applyEnv();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

describe('requireSession：密码会话的请求期复核', () => {
  it('SSO 未配齐时密码会话可用', async () => {
    const session = await requireSession(requestWith(await passwordSession()));
    expect(session.sub).toBe('local:ops-admin');
    expect(session.login_method).toBe('password');
  });

  it('SSO 配齐不再让密码会话失效（配好≠调通，需要人工确认后才关）', async () => {
    const token = await passwordSession();
    await applyEnv({}, true);

    const session = await requireSession(requestWith(token));
    expect(session.login_method).toBe('password');
  });

  it('运维显式把开关置 off 后密码会话立即失效（401）', async () => {
    const token = await passwordSession();
    await applyEnv({ PORTAL_ADMIN_LOGIN: 'off' }, true);

    await expect(requireSession(requestWith(token))).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    await expect(requireSession(requestWith(token))).rejects.toBeInstanceOf(ApiError);
  });

  it('PORTAL_ADMIN_LOGIN=on 时救急通道有效（即使 SSO 已配齐）', async () => {
    const token = await passwordSession();
    await applyEnv({ PORTAL_ADMIN_LOGIN: 'on' }, true);

    const session = await requireSession(requestWith(token));
    expect(session.sub).toBe('local:ops-admin');
  });

  it('PORTAL_ADMIN_LOGIN=off 时密码会话失效', async () => {
    const token = await passwordSession();
    await applyEnv({ PORTAL_ADMIN_LOGIN: 'off' });

    await expect(requireSession(requestWith(token))).rejects.toMatchObject({ status: 401 });
  });

  it('SSO 会话不受 SSO 配齐影响', async () => {
    const token = await ssoSession();
    await applyEnv({}, true);

    const session = await requireSession(requestWith(token));
    expect(session.sub).toBe('100051:teacher-1');
    expect(session.login_method).toBeUndefined();
  });
});
