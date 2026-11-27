import { beforeEach, describe, expect, it } from 'vitest';
import { makeDataDir, memberRequest, resetMembersEnv } from '../helpers/members';
import { mutateStore, readStore } from '@/lib/members/store';

import { POST as submit } from '@/app/api/portal/members/route';
import { POST as updateContact } from '@/app/api/portal/members/[id]/contact/route';

const validBody = {
  email: 'zhangsan@school.edu',
  countryCode: '86',
  phone: '13800000000',
  departmentPath: '教务处',
};

let dataDir = '';

async function seed(): Promise<string> {
  const response = await submit(
    await memberRequest('http://portal.test/api/portal/members', { body: validBody })
  );
  const body = (await response.json()) as { application: { id: string } };
  return body.application.id;
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mutateStore((apps) => {
    const app = apps.find((item) => item.id === id);
    if (app) Object.assign(app, { status, ...extra });
  });
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  resetMembersEnv({ PORTAL_DATA_DIR: dataDir });
});

describe('POST /api/portal/members/[id]/contact', () => {
  it('非本人申请单返回 404，且不修改记录', async () => {
    const id = await seed();

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        sub: '7:99999',
        body: { email: 'other@school.edu', countryCode: '86', phone: '13900000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(404);
    const apps = await readStore();
    expect(apps[0].email).toBe('zhangsan@school.edu');
  });

  it('pending 期间本人改资料：状态保持 pending，revision 递增，事件标记为修改后重新提交', async () => {
    const id = await seed();

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'fixed@school.edu', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].status).toBe('pending');
    expect(apps[0].email).toBe('fixed@school.edu');
    // 首次提交 revision 为 0，改资料后重新提交应递增到 1，管理员据此区分
    expect(apps[0].revision).toBe(1);
    // 只改联系方式时部门保持不变
    expect(apps[0].departmentPath).toBe('教务处');
    expect(apps[0].events.at(-1)?.actor).toBe('user');
    expect(apps[0].events.at(-1)?.note).toContain('修改资料后重新提交');
  });

  it('连续两次改资料 revision 累加，管理员可区分第几次重提', async () => {
    const id = await seed();

    for (const email of ['first-fix@school.edu', 'second-fix@school.edu']) {
      await updateContact(
        await memberRequest('http://portal.test/api/portal/members/x/contact', {
          body: { email, countryCode: '86', phone: '13800000000' },
        }),
        { params: Promise.resolve({ id }) }
      );
    }

    const apps = await readStore();
    expect(apps[0].revision).toBe(2);
  });

  it('needs_email 提交新邮箱后回到 pending', async () => {
    const id = await seed();
    await setStatus(id, 'needs_email');

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'new@school.edu', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].status).toBe('pending');
    expect(apps[0].events.at(-1)?.from).toBe('needs_email');
  });

  it('旧邮箱保留在事件轨迹里', async () => {
    const id = await seed();
    await setStatus(id, 'rejected');

    await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'new@school.edu', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    const apps = await readStore();
    expect(apps[0].events.at(-1)?.note).toContain('zhangsan@school.edu');
  });

  it('active 不允许修改，返回 409', async () => {
    const id = await seed();
    await setStatus(id, 'active');

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'new@school.edu', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'already_active' });
  });

  it('provisioning 不允许修改，返回 409', async () => {
    const id = await seed();
    await setStatus(id, 'provisioning', { provisioningStartedAt: new Date().toISOString() });

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'new@school.edu', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'provision_in_progress' });
  });

  it('资料格式非法返回 400', async () => {
    const id = await seed();

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: { email: 'bad', countryCode: '86', phone: '13800000000' },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(400);
  });

  it('同时提交部门时两者都更新，并清空旧的解析结果', async () => {
    const id = await seed();
    await setStatus(id, 'pending', { resolvedNodeId: 2, resolvedNodePath: '教务处' });

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: {
          email: 'fixed@school.edu',
          countryCode: '86',
          phone: '13800000000',
          departmentPath: ' 教务处 ／ 物理组 ',
        },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].email).toBe('fixed@school.edu');
    expect(apps[0].departmentPath).toBe('教务处/物理组');
    expect(apps[0].resolvedNodeId).toBeNull();
    expect(apps[0].resolvedNodePath).toBeNull();
  });

  it('部门非法返回 400 invalid_department，且联系方式不写入（原子）', async () => {
    const id = await seed();

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: {
          email: 'fixed@school.edu',
          countryCode: '86',
          phone: '13800000000',
          departmentPath: '教务处//物理组',
        },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_department' });

    const apps = await readStore();
    expect(apps[0].email).toBe('zhangsan@school.edu');
    expect(apps[0].departmentPath).toBe('教务处');
  });

  it('开通中断（超过 120 秒）后本人可补填部门并回到 pending', async () => {
    const id = await seed();
    await setStatus(id, 'provisioning', {
      provisioningStartedAt: new Date(Date.now() - 121_000).toISOString(),
      departmentPath: '',
    });

    const response = await updateContact(
      await memberRequest('http://portal.test/api/portal/members/x/contact', {
        body: {
          email: 'zhangsan@school.edu',
          countryCode: '86',
          phone: '13800000000',
          departmentPath: '教务处/物理组',
        },
      }),
      { params: Promise.resolve({ id }) }
    );

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].status).toBe('pending');
    expect(apps[0].departmentPath).toBe('教务处/物理组');
    expect(apps[0].events.at(-1)).toMatchObject({ from: 'provisioning', to: 'pending' });
    expect(apps[0].events.at(-1)?.note).toContain('中断');
  });
});
