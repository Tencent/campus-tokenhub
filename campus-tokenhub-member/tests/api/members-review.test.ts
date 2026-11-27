import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAdminRosterRepoOverride } from '@/lib/admin/roster';
import { makeDataDir, memberRequest, resetMembersEnv } from '../helpers/members';
import { mutateStore, readStore } from '@/lib/members/store';

/** 内存版共享名单：审核判权走 resolvePortalAdmin → readAdminSubs */
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

const mocks = vi.hoisted(() => ({
  provisionApplication: vi.fn(),
  audit: vi.fn(),
  readMemberAdminSubs: vi.fn(),
}));

vi.mock('@/lib/members/provision', () => ({
  provisionApplication: mocks.provisionApplication,
}));

vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: mocks.audit };
});

import { POST as submit } from '@/app/api/portal/members/route';
import { POST as review } from '@/app/api/portal/members/[id]/review/route';

const validBody = {
  email: 'zhangsan@school.edu',
  countryCode: '86',
  phone: '13800000000',
  departmentPath: '教务处',
};

const ADMIN_SUB = '7:1';

let dataDir = '';

async function seed(): Promise<string> {
  const response = await submit(
    await memberRequest('http://portal.test/api/portal/members', { body: validBody })
  );
  const body = (await response.json()) as { application?: { id: string }; code?: string; error?: string };
  if (!body.application) {
    throw new Error(`seed failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.application.id;
}

async function setStatus(id: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  await mutateStore((apps) => {
    const app = apps.find((item) => item.id === id);
    if (app) Object.assign(app, { status, ...extra });
  });
}

function reviewRequest(id: string, body: unknown, sub = ADMIN_SUB): Promise<Request> {
  return memberRequest(`http://portal.test/api/portal/members/${id}/review`, { sub, body });
}

beforeEach(async () => {
  dataDir = await makeDataDir();
  resetMembersEnv({ PORTAL_DATA_DIR: dataDir });
  vi.clearAllMocks();
  setAdminRosterRepoOverride(rosterRepo([ADMIN_SUB]));
  mocks.provisionApplication.mockResolvedValue({
    status: 'active',
    uin: '123456',
    errorCode: null,
    errorMessage: null,
    requestId: 'req-1',
    resolvedNodeId: 2,
    resolvedNodePath: '教务处',
    createdDepartments: [],
  });
});

describe('POST /api/portal/members/[id]/review', () => {
  it('非管理员返回 403', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'approve' }, '7:17915'), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_member_admin' });
    expect(mocks.provisionApplication).not.toHaveBeenCalled();
  });

  it('驳回缺理由返回 400，状态仍为 pending', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'reject' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(400);
    const apps = await readStore();
    expect(apps[0].status).toBe('pending');
  });

  it('驳回写理由后状态变 rejected，并写审计', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'reject', note: '资料不全' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].status).toBe('rejected');
    expect(apps[0].reviewNote).toBe('资料不全');
    expect(mocks.audit).toHaveBeenCalledWith('member.review', expect.objectContaining({ result: 'rejected' }));
  });

  it('通过后调用编排并落最终状态', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'approve' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.provisionApplication).toHaveBeenCalledTimes(1);
    // 根节点不再由配置传入：编排内部自动识别（department 层负责）
    expect(mocks.provisionApplication).toHaveBeenCalledWith(
      expect.not.objectContaining({ rootNodeId: expect.anything() })
    );

    const apps = await readStore();
    expect(apps[0].status).toBe('active');
    expect(apps[0].uin).toBe('123456');
    expect(apps[0].resolvedNodeId).toBe(2);
    expect(apps[0].resolvedNodePath).toBe('教务处');
    // 成功单不保留 RequestId：否则审核页会把「原始错误：—」当成仍有错误
    expect(apps[0].tencentRequestId).toBeNull();
    expect(mocks.audit).toHaveBeenCalledWith('member.review', expect.objectContaining({ result: 'approve' }));
  });

  it('部门为空的申请单不能通过，状态保持 pending', async () => {
    const id = await seed();
    await setStatus(id, 'pending', { departmentPath: '' });

    const response = await review(await reviewRequest(id, { action: 'approve' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'department_missing' });
    expect(mocks.provisionApplication).not.toHaveBeenCalled();

    const apps = await readStore();
    expect(apps[0].status).toBe('pending');
  });

  it('部门解析失败时落 failed 与部门错误码', async () => {
    mocks.provisionApplication.mockResolvedValue({
      status: 'failed',
      uin: null,
      errorCode: 'department_conflict',
      errorMessage: '部门名与腾讯云已有部门冲突',
      requestId: 'req-x',
      resolvedNodeId: null,
      resolvedNodePath: null,
      createdDepartments: [],
    });

    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'approve' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    const apps = await readStore();
    expect(apps[0].status).toBe('failed');
    expect(apps[0].errorCode).toBe('department_conflict');
    expect(apps[0].resolvedNodeId).toBeNull();
  });

  it('双击通过：第二次返回当前状态，不重复开通', async () => {
    const id = await seed();
    await review(await reviewRequest(id, { action: 'approve' }), { params: Promise.resolve({ id }) });
    const second = await review(await reviewRequest(id, { action: 'approve' }), {
      params: Promise.resolve({ id }),
    });

    expect(second.status).toBe(200);
    expect(mocks.provisionApplication).toHaveBeenCalledTimes(1);
  });

  it('provisioning 未超时点重试返回 409，且不调用腾讯云', async () => {
    const id = await seed();
    await setStatus(id, 'provisioning', { provisioningStartedAt: new Date().toISOString() });

    const response = await review(await reviewRequest(id, { action: 'retry' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'provision_in_progress' });
    expect(mocks.provisionApplication).not.toHaveBeenCalled();
  });

  it('provisioning 超 120 秒后重试可重新执行', async () => {
    const id = await seed();
    await setStatus(id, 'provisioning', {
      provisioningStartedAt: new Date(Date.now() - 121_000).toISOString(),
    });

    const response = await review(await reviewRequest(id, { action: 'retry' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.provisionApplication).toHaveBeenCalledTimes(1);
  });

  it('failed 可以重试', async () => {
    const id = await seed();
    await setStatus(id, 'failed');

    const response = await review(await reviewRequest(id, { action: 'retry' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.provisionApplication).toHaveBeenCalledTimes(1);
  });

  it('pending 单不允许 retry', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'retry' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_retryable' });
  });

  it('未知 action 返回 400', async () => {
    const id = await seed();
    const response = await review(await reviewRequest(id, { action: 'delete' }), {
      params: Promise.resolve({ id }),
    });

    expect(response.status).toBe(400);
  });

  it('申请单不存在返回 404', async () => {
    const response = await review(await reviewRequest('nope', { action: 'approve' }), {
      params: Promise.resolve({ id: 'nope' }),
    });

    expect(response.status).toBe(404);
  });

});
