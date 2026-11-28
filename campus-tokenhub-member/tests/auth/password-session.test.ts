import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/guard';
import { requireSession } from '@/lib/api/guard';
import { signSession } from '@/lib/auth/session';
import { resetConfigCache } from '@/lib/config';
import {
  emptyOverlayStored,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';

const SECRET = 'password-session-test-secret-32-chars-ok';

const BASE_ENV: Record<string, string> = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
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
    admin: true,
    loginMethod: 'password',
  });
}

async function ssoSession(): Promise<string> {
  return signSession({
    sub: '100051:teacher-1',
    email: 'teacher@school.edu',
    name: '老师',
  });
}

beforeEach(() => {
  applyEnv();
  resetOverlayForTests();
  setOverlayLoader(async () => emptyOverlayStored());
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

  it('SSO 配齐后密码会话不失效（不再自动关闭，等运维确认后由人置 off）', async () => {
    const token = await passwordSession();
    applyEnv(SSO_READY);

    const session = await requireSession(requestWith(token));
    expect(session.sub).toBe('local:ops-admin');
    expect(session.login_method).toBe('password');
  });

  it('PORTAL_ADMIN_LOGIN=on 时救急通道有效（即使 SSO 已配齐）', async () => {
    const token = await passwordSession();
    applyEnv({ ...SSO_READY, PORTAL_ADMIN_LOGIN: 'on' });

    const session = await requireSession(requestWith(token));
    expect(session.sub).toBe('local:ops-admin');
  });

  it('PORTAL_ADMIN_LOGIN=off 时密码会话失效', async () => {
    const token = await passwordSession();
    applyEnv({ PORTAL_ADMIN_LOGIN: 'off' });

    await expect(requireSession(requestWith(token))).rejects.toMatchObject({ status: 401 });
  });

  it('SSO 会话不受 SSO 配齐影响', async () => {
    const token = await ssoSession();
    applyEnv(SSO_READY);

    const session = await requireSession(requestWith(token));
    expect(session.sub).toBe('100051:teacher-1');
    expect(session.login_method).toBeUndefined();
  });
});
