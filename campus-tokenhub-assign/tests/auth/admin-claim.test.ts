import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { establishSession } from '@/lib/auth/login';
import { verifySession } from '@/lib/auth/session';
import { clearAdminRoster, stubAdminRoster } from '../helpers/admin-roster';

/**
 * 判定口径：数据库管理员名单命中，或（名单为空时）初始化 owner。
 * owner 存在网关里，这里把读网关的入口换成可控的桩，测试不依赖网络。
 */
const ownerState = vi.hoisted(() => ({ current: null as string | null }));

vi.mock('@/lib/onboarding/state', () => ({
  readOnboardingSnapshot: async () => ({ completed: false, owner: ownerState.current }),
}));

const SECRET = 'unit-test-secret-that-is-long-enough';

function setEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    OCTAFUSE_ADMIN_BASE: 'http://127.0.0.1:8789',
    OCTAFUSE_PROXY_BASE: 'http://127.0.0.1:8790',
    OCTAFUSE_ADMIN_USERNAME: 'admin',
    OCTAFUSE_ADMIN_PASSWORD: 'pw',
    OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
    SESSION_SECRET: SECRET,
    ...overrides,
  });
  resetConfigCache();
}

const identity = { sub: 'teacher-1', email: 'Teacher@School.edu', name: '李老师' };

async function sessionFor(
  email: string,
  sub = identity.sub
): Promise<Awaited<ReturnType<typeof verifySession>>> {
  const token = await establishSession({ ...identity, sub, email });
  return verifySession(token);
}

beforeEach(() => {
  ownerState.current = null;
  setEnv();
  stubAdminRoster([]);
});

afterEach(() => {
  ownerState.current = null;
  clearAdminRoster();
  resetConfigCache();
});

describe('establishSession 的 admin 声明（数据库名单）', () => {
  it('名单命中时写入 admin: true', async () => {
    stubAdminRoster([identity.sub]);

    const session = await sessionFor(identity.email);

    expect(session!.admin).toBe(true);
  });

  it('名单未命中时不含 admin 声明', async () => {
    stubAdminRoster(['teacher-2']);

    const session = await sessionFor(identity.email);

    expect(session!.admin).toBe(false);
  });

  it('名单非空时不再看 owner（名单优先）', async () => {
    stubAdminRoster(['teacher-2']);
    ownerState.current = identity.sub;

    const session = await sessionFor(identity.email);

    expect(session!.admin).toBe(false);
  });

  it('名单为空时，首个登录的 school_id:user_id 身份自动认领为管理员', async () => {
    stubAdminRoster([]);

    const session = await sessionFor(identity.email, '100051:teacher-1');

    expect(session!.admin).toBe(true);
  });

  it('名单里只有历史脏数据 local:ops-admin 时，首个 SSO 用户仍能认领为管理员', async () => {
    stubAdminRoster(['local:ops-admin']);

    const session = await sessionFor(identity.email, '100051:teacher-1');

    expect(session!.admin).toBe(true);
  });

  it('身份不是 school_id:user_id 时不认领（不可靠身份不给管理权）', async () => {
    stubAdminRoster([]);
    ownerState.current = identity.sub;

    const session = await sessionFor('');

    expect(session!.admin).toBe(false);
  });

  it('名单为空且身份不是 owner 时不授权（fail closed）', async () => {
    stubAdminRoster([]);
    ownerState.current = 'teacher-2';

    const session = await sessionFor('');

    expect(session!.admin).toBe(false);
  });

  it('名单为空且尚未认领 owner 时不授权', async () => {
    stubAdminRoster([]);
    ownerState.current = null;

    const session = await sessionFor(identity.email);

    expect(session!.admin).toBe(false);
  });
});

describe('引导期管理员身份（账号密码登录）', () => {
  const localSub = 'local:ops-admin';

  function setLocalAdmin(overrides: Record<string, string> = {}): void {
    setEnv({
      PORTAL_ADMIN_USERNAME: 'ops-admin',
      PORTAL_ADMIN_PASSWORD: 'bootstrap-password-1234',
      ...overrides,
    });
  }

  it('local:<username> 直接被判定为管理员（不在名单、也没有 owner）', async () => {
    setLocalAdmin();
    ownerState.current = null;

    const { resolvePortalAdmin } = await import('@/lib/auth/admin');
    await expect(resolvePortalAdmin({ sub: localSub, email: 'ops-admin@local' })).resolves.toBe(true);
  });

  it('其它 sub 不会借道获得管理员权限', async () => {
    setLocalAdmin();

    const { resolvePortalAdmin } = await import('@/lib/auth/admin');
    await expect(resolvePortalAdmin({ sub: 'local:someone-else', email: '' })).resolves.toBe(false);
    await expect(resolvePortalAdmin({ sub: '100051:teacher-1', email: '' })).resolves.toBe(false);
  });

  it('未配置引导凭据时该身份不成立', async () => {
    setEnv({ PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' });

    const { resolvePortalAdmin } = await import('@/lib/auth/admin');
    await expect(resolvePortalAdmin({ sub: localSub, email: 'ops-admin@local' })).resolves.toBe(false);
  });

  it('withAdminClaim 会给引导身份打上 admin 声明', async () => {
    setLocalAdmin();

    const { withAdminClaim } = await import('@/lib/auth/admin');
    const claimed = await withAdminClaim({
      sub: localSub,
      email: 'ops-admin@local',
      name: 'ops-admin',
      octafuseUserId: null,
    });

    expect(claimed.admin).toBe(true);
  });
});
