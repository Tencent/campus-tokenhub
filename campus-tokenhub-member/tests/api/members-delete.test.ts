import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminRosterRepoOverride } from '@/lib/admin/roster';
import { makeDataDir, memberRequest, resetMembersEnv } from '../helpers/members';

import { POST as submit } from '@/app/api/portal/members/route';
import { POST as review } from '@/app/api/portal/members/[id]/review/route';
import { DELETE as removeMember } from '@/app/api/portal/members/[id]/route';
import { TencentApiError } from '@/lib/tencent/organization';

/**
 * 删除的可变实现：默认走真实 mock 客户端，需要模拟云侧失败时改这个函数。
 * 只替换 deleteMember，建号/绑邮箱等仍走真实 mock，避免把整条链路都 mock 掉。
 */
let deleteImpl: (uin: string) => Promise<{ requestId: string; alreadyGone: boolean }>;

vi.mock('@/lib/tencent/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/tencent/factory')>();
  return {
    ...actual,
    getOrganizationClient: () => {
      const client = actual.getOrganizationClient();
      return { ...client, deleteMember: (uin: string) => deleteImpl(uin) };
    },
  };
});

const ADMIN_SUB = '7:1';
const APPLICANT_SUB = '7:17915';

let dataDir = '';

async function submitAs(sub: string): Promise<string> {
  const response = await submit(
    await memberRequest('http://portal.test/api/portal/members', {
      sub,
      body: {
        email: `${sub.replace(':', '-')}@school.edu`,
        countryCode: '86',
        phone: '13800000000',
        departmentPath: '教务处/数学组',
      },
    })
  );
  const payload = (await response.json()) as { application?: { id: string } };
  return payload.application?.id ?? '';
}

async function approveAs(id: string): Promise<void> {
  await review(
    await memberRequest(`http://portal.test/api/portal/members/${id}/review`, {
      sub: ADMIN_SUB,
      body: { action: 'approve' },
    }),
    { params: Promise.resolve({ id }) }
  );
}

async function removeAs(
  id: string,
  sub = ADMIN_SUB
): Promise<{ status: number; body: any }> {
  const response = await removeMember(
    await memberRequest(`http://portal.test/api/portal/members/${id}`, { method: 'DELETE', sub }),
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
  setAdminRosterRepoOverride(rosterRepo([ADMIN_SUB]));
  deleteImpl = async () => ({ requestId: 'mock-req', alreadyGone: false });
});

describe('删除成员账号', () => {
  it('已开通的账号可以删除，记录保留为 deleted', async () => {
    const id = await submitAs(APPLICANT_SUB);
    await approveAs(id);

    const result = await removeAs(id);

    expect(result.status).toBe(200);
    expect(result.body.application.status).toBe('deleted');
    expect(result.body.application.deletedAt).toBeTruthy();
    expect(result.body.application.uin).toBeTruthy();
    // 记录保留，可追溯
    expect(result.body.application.id).toBe(id);
  });

  it('不允许删除自己的账号', async () => {
    const id = await submitAs(ADMIN_SUB);
    await approveAs(id);

    const result = await removeAs(id, ADMIN_SUB);

    expect(result.status).toBe(403);
    expect(result.body.code).toBe('cannot_delete_self');
  });

  it('未开通的申请不能走删除（撤销申请是另一件事）', async () => {
    const id = await submitAs(APPLICANT_SUB);

    const result = await removeAs(id);

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('no_uin');
  });

  it('云侧拒绝删除时回滚到 active 并留下原因', async () => {
    const id = await submitAs(APPLICANT_SUB);
    await approveAs(id);

    deleteImpl = async () => {
      // 云侧错误一律是 TencentApiError；非腾讯错误只给泛化文案，不透传内部信息
      throw new TencentApiError('FailedOperation.BillNotSettled', '成员名下有未结清账单');
    };

    const failed = await removeAs(id);
    expect(failed.status).toBe(502);

    // 回滚后可再次删除，且失败原因可见
    deleteImpl = async () => ({ requestId: 'mock-req', alreadyGone: false });
    const mine = await (
      await import('@/app/api/portal/members/route')
    ).GET(
      await memberRequest('http://portal.test/api/portal/members', {
        method: 'GET',
        sub: APPLICANT_SUB,
      })
    );
    const payload = (await mine.json()) as { application: { status: string; deleteError: string } };
    expect(payload.application.status).toBe('active');
    expect(payload.application.deleteError).toContain('未结清账单');

    const retried = await removeAs(id);
    expect(retried.status).toBe(200);
    expect(retried.body.application.status).toBe('deleted');
  });

  it('云侧已无此成员时按删除成功处理（幂等）', async () => {
    const id = await submitAs(APPLICANT_SUB);
    await approveAs(id);

    deleteImpl = async () => ({ requestId: 'req-gone', alreadyGone: true });

    const result = await removeAs(id);

    expect(result.status).toBe(200);
    expect(result.body.application.status).toBe('deleted');
    expect(result.body.alreadyGone).toBe(true);
  });

  it('删除后本人可以重新申请', async () => {
    const id = await submitAs(APPLICANT_SUB);
    await approveAs(id);
    await removeAs(id);

    const again = await submit(
      await memberRequest('http://portal.test/api/portal/members', {
        sub: APPLICANT_SUB,
        body: {
          email: 'liao@school.edu',
          countryCode: '86',
          phone: '13900139000',
          departmentPath: '教务处/数学组',
        },
      })
    );
    const payload = (await again.json()) as { application: { id: string; status: string } };

    expect(again.status).toBeLessThan(300);
    expect(payload.application.status).toBe('pending');
    // 沿用同一条记录
    expect(payload.application.id).toBe(id);
  });
});
