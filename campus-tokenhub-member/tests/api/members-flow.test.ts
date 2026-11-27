import { beforeEach, describe, expect, it } from 'vitest';
import { setAdminRosterRepoOverride } from '@/lib/admin/roster';
import { makeDataDir, memberRequest, resetMembersEnv } from '../helpers/members';

import { GET as getMine, POST as submit } from '@/app/api/portal/members/route';
import { POST as review } from '@/app/api/portal/members/[id]/review/route';
import { POST as updateContact } from '@/app/api/portal/members/[id]/contact/route';

const ADMIN_SUB = '7:1';

let dataDir = '';

async function submitAs(sub: string, body: Record<string, unknown>): Promise<{ id: string; status: number }> {
  const response = await submit(
    await memberRequest('http://portal.test/api/portal/members', { sub, body })
  );
  const payload = (await response.json()) as { application?: { id: string } };
  return { id: payload.application?.id ?? '', status: response.status };
}

async function reviewAs(id: string, body: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const response = await review(
    await memberRequest(`http://portal.test/api/portal/members/${id}/review`, {
      sub: ADMIN_SUB,
      body,
    }),
    { params: Promise.resolve({ id }) }
  );
  return { status: response.status, body: await response.json() };
}

function rosterRepo(subs: string[]) {
  let list = [...subs];
  return {
    async list() {
      return [...list];
    },
    async replaceAll(next: string[]) {
      list = [...next];
    },
    async add(entries: string[]) {
      for (const entry of entries) if (!list.includes(entry)) list.push(entry);
    },
    async remove(sub: string) {
      list = list.filter((item) => item !== sub);
    },
  };
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  resetMembersEnv({ PORTAL_DATA_DIR: dataDir });
  // 审核权限走 resolvePortalAdmin → 共享名单：注入一份含管理员的内存名单
  setAdminRosterRepoOverride(rosterRepo([ADMIN_SUB]));
});

/** 全链路用真实 mock 客户端（MEMBER_ACCOUNT_PROVIDER=mock），不 mock 编排与客户端 */
describe('成员账号全链路（mock 腾讯云客户端）', () => {
  it('提交 → 审核通过 → active', async () => {
    const created = await submitAs('7:17915', {
      email: 'zhangsan@school.edu',
      countryCode: '86',
      phone: '13800000000',
      departmentPath: '教务处/数学组',
    });
    expect(created.status).toBe(201);

    const approved = await reviewAs(created.id, { action: 'approve' });
    expect(approved.status).toBe(200);
    expect(approved.body.application.status).toBe('active');
    expect(approved.body.application.uin).toBeTruthy();

    const mine = await getMine(
      await memberRequest('http://portal.test/api/portal/members', { method: 'GET', sub: '7:17915' })
    );
    const payload = (await mine.json()) as { application: { status: string } };
    expect(payload.application.status).toBe('active');
  });

  it('邮箱被占用 → needs_email → 换邮箱重提 → 再次审核 → active', async () => {
    // 先把 zhangsan@school.edu 绑到 A 的成员账号上
    const first = await submitAs('7:1001', {
      email: 'zhangsan@school.edu',
      countryCode: '86',
      phone: '13900000001',
      departmentPath: '教务处',
    });
    await reviewAs(first.id, { action: 'approve' });

    // B 用同一个邮箱申请 → 建号成功但绑定失败
    const second = await submitAs('7:1002', {
      email: 'zhangsan@school.edu',
      countryCode: '86',
      phone: '13900000002',
      departmentPath: '教务处',
    });
    const blocked = await reviewAs(second.id, { action: 'approve' });

    expect(blocked.body.application.status).toBe('needs_email');
    expect(blocked.body.application.uin).toBeTruthy();

    // B 换邮箱重提（直接改资料即可，状态回 pending）
    const fixed = await updateContact(
      await memberRequest(`http://portal.test/api/portal/members/${second.id}/contact`, {
        sub: '7:1002',
        body: { email: 'lisi@school.edu', countryCode: '86', phone: '13900000002' },
      }),
      { params: Promise.resolve({ id: second.id }) }
    );
    expect(fixed.status).toBe(200);
    await expect(fixed.json()).resolves.toMatchObject({
      application: { status: 'pending', email: 'lisi@school.edu' },
    });

    const retried = await reviewAs(second.id, { action: 'approve' });
    expect(retried.body.application.status).toBe('active');
  });

  it('开通失败后本人重新发起申请 → 再次审核 → active', async () => {
    const created = await submitAs('7:3001', {
      email: 'zhaoliu@school.edu',
      countryCode: '86',
      phone: '13900000004',
      departmentPath: '教务处',
    });
    expect(created.status).toBe(201);

    // 模拟审核通过后编排落 failed（真实链路见 provision.test.ts）
    const { mutateStore } = await import('@/lib/members/store');
    await mutateStore((apps) => {
      const app = apps.find((item) => item.id === created.id);
      if (app) {
        app.status = 'failed';
        app.errorCode = 'FailedOperation.CreateAccount';
        app.errorMessage = '开通失败，请联系管理员重试';
      }
    });

    // 本人改资料 + 换部门后重新发起申请
    const reapplied = await submitAs('7:3001', {
      email: 'zhaoliu2@school.edu',
      countryCode: '86',
      phone: '13900000005',
      departmentPath: '教务处/数学组',
      remark: '换部门重提',
    });
    expect(reapplied.status).toBe(201);
    expect(reapplied.id).toBe(created.id);

    const approved = await reviewAs(created.id, { action: 'approve' });
    expect(approved.body.application.status).toBe('active');
    expect(approved.body.application.email).toBe('zhaoliu2@school.edu');
  });

  it('重复审核同一单不会重复建号（成员名唯一）', async () => {
    const created = await submitAs('7:2001', {
      email: 'wangwu@school.edu',
      countryCode: '86',
      phone: '13900000003',
      departmentPath: '教务处/数学组',
    });

    const first = await reviewAs(created.id, { action: 'approve' });
    const second = await reviewAs(created.id, { action: 'approve' });

    expect(first.body.application.uin).toBe(second.body.application.uin);
    expect(second.body.application.status).toBe('active');
  });

  it('部门不存在时审核通过自动逐级创建，并写回 resolvedNodePath', async () => {
    const created = await submitAs('7:4001', {
      email: 'physics@school.edu',
      countryCode: '86',
      phone: '13900000006',
      departmentPath: '教务处/物理组/高一',
    });

    const approved = await reviewAs(created.id, { action: 'approve' });
    expect(approved.body.application.status).toBe('active');
    expect(approved.body.application.resolvedNodePath).toBe('教务处/物理组/高一');
    expect(approved.body.application.resolvedNodeId).toBeGreaterThan(0);

    const { getOrganizationClient } = await import('@/lib/tencent/factory');
    const { nodes } = await getOrganizationClient().describeNodes();
    const names = nodes.map((node) => node.name);
    expect(names).toEqual(expect.arrayContaining(['物理组', '高一']));
  });
});
