import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { establishSession } from '@/lib/auth/login';
import { verifySession } from '@/lib/auth/session';
import { readAdminSubs, resetAdminRosterCache } from '@/lib/admin/roster';
import { membersBaseEnv, stubAdminRoster as setAdminRoster } from '../helpers/members';

/**
 * 管理员判定只有两个来源：引导期本地账号（`local:<username>`）与共享名单 `portal_shared.admins`。
 * `ADMIN_EMAILS` 邮箱白名单已移除，所以这里不再有「邮箱命中」的用例——
 * 身份能否提权只看名单里有没有它的 `school_id:user_id`。
 *
 * 全新部署（名单为空）时靠**首登认领**破局：首个合法登录者在会话签发那一刻写进名单。
 */

const SECRET = 'unit-test-secret-that-is-long-enough';

function setEnv(overrides: Record<string, string> = {}): void {
  process.env = {
    ...process.env,
    ...membersBaseEnv,
    SESSION_SECRET: SECRET,
    ...overrides,
  };
  resetConfigCache();
  resetAdminRosterCache();
}

/** 名单为空，模拟「刚部署完、还没配过管理员」 */
function emptyRoster(subs: string[] = []) {
  return setAdminRoster(subs);
}

const identity = { sub: '100051:teacher-1', email: 'Teacher@School.edu', name: '李老师' };

async function sessionFor(sub = identity.sub, email = identity.email) {
  const token = await establishSession({ ...identity, sub, email });
  return verifySession(token);
}

beforeEach(() => {
  setEnv();
  emptyRoster();
});

afterEach(() => {
  resetConfigCache();
  resetAdminRosterCache();
});

describe('establishSession 的 admin 声明（名单 + 首登认领）', () => {
  it('名单为空时：首个登录者自动认领为管理员', async () => {
    const roster = emptyRoster();

    const session = await sessionFor();

    expect(session!.admin).toBe(true);
    await expect(readAdminSubs()).resolves.toMatchObject({ subs: [identity.sub], managed: true });
    await expect(roster.list()).resolves.toEqual([identity.sub]);
  });

  it('名单里只有历史脏数据 local:ops-admin 时，首个 SSO 用户仍能认领为管理员', async () => {
    const roster = emptyRoster(['local:ops-admin']);

    const session = await sessionFor();

    expect(session!.admin).toBe(true);
    await expect(readAdminSubs()).resolves.toMatchObject({ subs: [identity.sub], managed: true });
    await expect(roster.list()).resolves.toEqual(['local:ops-admin', identity.sub]);
  });

  it('只认领一次：第二个人登录不会跟着变成管理员', async () => {
    emptyRoster();

    await sessionFor();
    const second = await sessionFor('100051:teacher-2', 'teacher2@school.edu');

    expect(second!.admin).toBe(false);
    await expect(readAdminSubs()).resolves.toMatchObject({ subs: [identity.sub] });
  });

  it('名单非空时不认领：登录者不在名单里就不是管理员', async () => {
    emptyRoster(['100051:someone-else']);

    const session = await sessionFor();

    expect(session!.admin).toBe(false);
    await expect(readAdminSubs()).resolves.toMatchObject({ subs: ['100051:someone-else'] });
  });

  it('名单命中即管理员（与邮箱无关）', async () => {
    emptyRoster([identity.sub]);

    const session = await sessionFor(identity.sub, 'anyone@whatever.test');

    expect(session!.admin).toBe(true);
  });

  it('邮箱改写不影响判定：同邮箱换 sub 就失去管理员', async () => {
    emptyRoster([identity.sub]);

    const session = await sessionFor('100051:teacher-9', identity.email);

    expect(session!.admin).toBe(false);
  });

  it('非 school_id:user_id 形式的身份不参与认领（避免不可靠身份拿到管理权）', async () => {
    const roster = emptyRoster();

    const session = await sessionFor('teacher-1', 'teacher@school.edu');

    expect(session!.admin).toBe(false);
    await expect(roster.list()).resolves.toEqual([]);
  });

  it('resolvePortalAdmin 是纯读：名单为空时不会顺手写库', async () => {
    const roster = emptyRoster();
    const { resolvePortalAdmin } = await import('@/lib/auth/admin');

    await expect(resolvePortalAdmin({ sub: identity.sub, email: identity.email })).resolves.toBe(
      false
    );
    await expect(roster.list()).resolves.toEqual([]);
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

  it('local:<username> 直接被判定为管理员（不在名单里也算）', async () => {
    setLocalAdmin();
    emptyRoster();

    const { resolvePortalAdmin } = await import('@/lib/auth/admin');
    await expect(resolvePortalAdmin({ sub: localSub, email: 'ops-admin@local' })).resolves.toBe(true);
  });

  it('其它 sub 不会借道获得管理员权限', async () => {
    setLocalAdmin();
    emptyRoster();

    const { resolvePortalAdmin } = await import('@/lib/auth/admin');
    await expect(resolvePortalAdmin({ sub: 'local:someone-else', email: '' })).resolves.toBe(false);
    await expect(resolvePortalAdmin({ sub: '100051:teacher-1', email: '' })).resolves.toBe(false);
  });

  it('未配置引导凭据时该身份不成立', async () => {
    setEnv({ PORTAL_ADMIN_USERNAME: '', PORTAL_ADMIN_PASSWORD: '' });
    emptyRoster();

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
    });

    expect(claimed.admin).toBe(true);
  });
});
