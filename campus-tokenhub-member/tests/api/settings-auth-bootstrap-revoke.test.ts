import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PUT } from '@/app/api/portal/settings/route';
import { resetConfigCache } from '@/lib/config';
import { resetOverlayForTests } from '@/lib/config/overlay';
import { resetConfigStoreCache, setConfigRepoOverride } from '@/lib/config/store';
import { resetRuntimeSecretProvider } from '@/lib/config/secrets';
import { signSession } from '@/lib/auth/session';
import { resetPasswordRateLimit } from '@/lib/auth/password-rate-limit';
import { membersBaseEnv, stubAdminRoster } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const mocks = vi.hoisted(() => ({ revoke: vi.fn() }));

// 吊销在测试里没有数据库可写，替换成可控桩，只验证「什么时候调用、对谁调用」
vi.mock('@/lib/auth/revocation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/revocation')>();
  return { ...actual, revokeSessionsFor: mocks.revoke };
});

const ENDPOINT = 'http://portal.test/api/portal/settings';
const original = { ...process.env };

/** SSO 必填项齐全的一套值（保存后应触发吊销） */
const SSO_VALUES = {
  provider: 'oauth2',
  oauth2AuthorizationEndpoint: 'https://idp.example.com/oauth2/authorize',
  oauth2TokenEndpoint: 'https://idp.example.com/oauth2/token',
  oauth2UserInfoEndpoint: 'https://idp.example.com/oauth2/userinfo',
  oauth2ClientId: 'client-id',
  oauth2ClientSecret: 'client-secret',
};

function resetEnv(extra: Record<string, string> = {}): void {
  process.env = {
    ...original,
    ...membersBaseEnv,
    PORTAL_ADMIN_USERNAME: 'ops-admin',
    PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
    ...extra,
  };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
}

async function requestWith(
  identity: { sub: string; email: string; password?: boolean },
  body: unknown
): Promise<Request> {
  const token = await signSession({
    sub: identity.sub,
    email: identity.email,
    name: identity.sub,
    ...(identity.password ? { admin: true, loginMethod: 'password' as const } : {}),
  });

  return new Request(ENDPOINT, {
    method: 'PUT',
    headers: {
      cookie: `portal_session=${token}`,
      origin: 'http://portal.test',
      host: 'portal.test',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetEnv();
  resetPasswordRateLimit();
  vi.clearAllMocks();
  mocks.revoke.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  resetRuntimeSecretProvider();
  resetConfigStoreCache();
});

describe('保存配置后的引导会话收口', () => {
  it('引导会话把 SSO 填齐后：不再吊销（配好≠调通，等运维确认后手动关）', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await requestWith({ sub: 'local:ops-admin', email: 'ops-admin@local', password: true }, {
        values: SSO_VALUES,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('把开关置 off 后：吊销该身份的密码会话', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await requestWith({ sub: 'local:ops-admin', email: 'ops-admin@local', password: true }, {
        values: { ...SSO_VALUES, localAdminMode: 'off' },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.revoke).toHaveBeenCalledWith('local:ops-admin');
  });

  it('保存后 SSO 仍不完整：不吊销（还处在引导期）', async () => {
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await requestWith({ sub: 'local:ops-admin', email: 'ops-admin@local', password: true }, {
        values: { schoolName: '示例学校' },
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('PORTAL_ADMIN_LOGIN=on 时保留救急通道：不吊销', async () => {
    resetEnv({ PORTAL_ADMIN_LOGIN: 'on' });
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await requestWith({ sub: 'local:ops-admin', email: 'ops-admin@local', password: true }, {
        values: SSO_VALUES,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });

  it('普通 SSO 管理员的保存不受影响', async () => {
    resetEnv();
    stubAdminRoster(['100051:admin-1']);
    const { repo } = memoryConfigRepo();
    setConfigRepoOverride(repo);

    const response = await PUT(
      await requestWith({ sub: '100051:admin-1', email: 'admin@school.edu.cn' }, {
        values: SSO_VALUES,
      })
    );

    expect(response.status).toBe(200);
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
