import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { resetOverlayForTests, setOverlayStoredForTests } from '@/lib/config/overlay';
import { establishSession } from '@/lib/auth/login';
import { verifySession } from '@/lib/auth/session';
import { readAdminSubs } from '@/lib/admin/roster';
import { storedConfig } from '../helpers/config';
import { membersBaseEnv, resetMembersEnv, stubAdminRoster } from '../helpers/members';

/**
 * 角色自动同步管理员：登录用户的角色命中 `auth.adminRoles` 时写入共享名单。
 * 只增不删；名单非空时用桩避免「首登认领」把结果混淆成同步成功。
 */

const teacher = { sub: '100051:teacher-1', email: 'teacher@school.edu', name: '李老师' };

function setEnv(): void {
  process.env = { ...process.env, ...membersBaseEnv };
  resetConfigCache();
}

async function signedInAsAdmin(roles: string[], sub = teacher.sub): Promise<boolean> {
  const token = await establishSession({ ...teacher, sub, roles });
  const session = await verifySession(token);
  return Boolean(session?.admin);
}

beforeEach(() => {
  setEnv();
  stubAdminRoster(['100051:someone-else']);
});

afterEach(() => {
  resetMembersEnv();
  resetOverlayForTests();
  resetConfigCache();
});

describe('角色自动同步为管理员', () => {
  it('角色命中配置值（忽略大小写）时加入管理员名单', async () => {
    setOverlayStoredForTests(storedConfig({ adminRoles: ['School_Admin'] }));

    await expect(signedInAsAdmin(['student', 'school_admin'])).resolves.toBe(true);
    expect((await readAdminSubs()).subs).toContain(teacher.sub);
  });

  it('原本不是管理员，角色调整后重新登录即自动加入名单', async () => {
    setOverlayStoredForTests(storedConfig({ adminRoles: ['school_admin'] }));

    await expect(signedInAsAdmin(['student'])).resolves.toBe(false);
    expect((await readAdminSubs()).subs).not.toContain(teacher.sub);

    await expect(signedInAsAdmin(['student', 'school_admin'])).resolves.toBe(true);
    expect((await readAdminSubs()).subs).toContain(teacher.sub);
  });

  it('角色未命中时不加入', async () => {
    setOverlayStoredForTests(storedConfig({ adminRoles: ['school_admin'] }));

    await expect(signedInAsAdmin(['student'])).resolves.toBe(false);
    expect((await readAdminSubs()).subs).not.toContain(teacher.sub);
  });

  it('未配置角色时即使返回管理员角色也不同步', async () => {
    setOverlayStoredForTests(storedConfig());

    await expect(signedInAsAdmin(['school_admin'])).resolves.toBe(false);
    expect((await readAdminSubs()).subs).not.toContain(teacher.sub);
  });

  it('身份不是 school_id:user_id 时不写入名单（不可靠身份不提权）', async () => {
    setOverlayStoredForTests(storedConfig({ adminRoles: ['school_admin'] }));

    await expect(signedInAsAdmin(['school_admin'], 'teacher-1')).resolves.toBe(false);
    expect((await readAdminSubs()).subs).not.toContain('teacher-1');
  });
});
