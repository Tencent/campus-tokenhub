import { describe, expect, it, vi } from 'vitest';
import { provisionApplication } from '@/lib/members/provision';
import type { MemberApplication, OrganizationNode } from '@/lib/members/types';
import { TencentApiError, type OrganizationClient } from '@/lib/tencent/organization';

const ROOT: OrganizationNode = { nodeId: 1000, name: 'Root', parentId: 0, path: 'Root' };
const TEACH: OrganizationNode = {
  nodeId: 1001,
  name: '教务处',
  parentId: 1000,
  path: 'Root / 教务处',
};

function makeApp(overrides: Partial<MemberApplication> = {}): MemberApplication {
  return {
    id: 'app-1',
    applicantSub: '7:17915',
    applicantName: '张三',
    userId: 17915,
    memberName: '张三-17915',
    email: 'zhangsan@school.edu',
    countryCode: '86',
    phone: '13800000000',
    departmentPath: '教务处',
    resolvedNodeId: null,
    resolvedNodePath: null,
    remark: '',
    status: 'pending',
    uin: null,
    errorCode: null,
    errorMessage: null,
    tencentRequestId: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    provisioningStartedAt: null,
    removingStartedAt: null,
    deletedAt: null,
    deleteRequestId: null,
    deleteError: null,
    lastAttemptAt: null,
    revision: 0,
    events: [],
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    ...overrides,
  };
}

type ClientOverrides = Partial<OrganizationClient> & {
  createMember: OrganizationClient['createMember'];
  bindEmail: OrganizationClient['bindEmail'];
};

function makeClient(overrides: ClientOverrides): OrganizationClient {
  let nextNodeId = 5000;
  return {
    kind: 'mock',
    describeNodes: vi.fn().mockResolvedValue({ nodes: [ROOT, TEACH], truncated: false }),
    addNode: vi.fn(async () => ({ nodeId: nextNodeId++, requestId: 'req-add' })),
    getEmailBindStatus: vi.fn().mockResolvedValue({ bindStatus: 'Valid', requestId: 'r' }),
    findMemberByName: vi.fn().mockResolvedValue(null),
    deleteMember: async () => ({ requestId: 'mock-req', alreadyGone: false, pendingReview: false }),
    ...overrides,
  };
}

const baseInput = {
  policyType: 'Financial',
  permissionIds: [1, 2],
};

describe('provisionApplication', () => {
  it('全成功：active + uin + RequestId，Remark 为 portal:<sub>', async () => {
    const createMember = vi.fn().mockResolvedValue({ uin: '123456', requestId: 'req-1' });
    const bindEmail = vi.fn().mockResolvedValue({ bindId: 'b1', requestId: 'req-2' });
    const client = makeClient({ createMember, bindEmail });
    const audit = vi.fn();

    const outcome = await provisionApplication({
      app: makeApp(),
      client,
      ...baseInput,
      audit,
    });

    expect(outcome).toMatchObject({
      status: 'active',
      uin: '123456',
      errorCode: null,
      requestId: 'req-2',
      resolvedNodeId: 1001,
      resolvedNodePath: '教务处',
    });
    expect(createMember).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '张三-17915',
        accountName: '张三-17915',
        nodeId: 1001,
        remark: 'portal:7:17915',
        policyType: 'Financial',
        permissionIds: [1, 2],
      })
    );
    expect(bindEmail).toHaveBeenCalledWith(
      expect.objectContaining({ uin: '123456', email: 'zhangsan@school.edu' })
    );
    expect(audit).toHaveBeenCalledWith(
      'member.provision',
      expect.objectContaining({ target: '123456', result: 'active' })
    );
  });

  it('部门缺失时先建部门再建号，并写部门创建审计', async () => {
    const createMember = vi.fn().mockResolvedValue({ uin: '123456', requestId: 'r' });
    const client = makeClient({
      createMember,
      bindEmail: vi.fn().mockResolvedValue({ bindId: 'b', requestId: 'r' }),
    });
    const audit = vi.fn();

    const outcome = await provisionApplication({
      app: makeApp({ departmentPath: '教务处/物理组' }),
      client,
      ...baseInput,
      audit,
    });

    expect(outcome.status).toBe('active');
    expect(outcome.resolvedNodePath).toBe('教务处/物理组');
    expect(client.addNode).toHaveBeenCalledWith({
      parentNodeId: 1001,
      name: '物理组',
      remark: 'portal:auto',
    });
    expect(createMember).toHaveBeenCalledWith(expect.objectContaining({ nodeId: 5000 }));
    expect(audit).toHaveBeenCalledWith(
      'member.department.create',
      expect.objectContaining({ target: '教务处/物理组', result: 'created' })
    );
  });

  it('部门解析失败时不建号，状态 failed 且带部门错误码', async () => {
    const createMember = vi.fn();
    const bindEmail = vi.fn();
    const client = makeClient({
      createMember,
      bindEmail,
      describeNodes: vi
        .fn()
        .mockRejectedValue(new TencentApiError('UnauthorizedOperation', 'no permission', 'req-x')),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('UnauthorizedOperation');
    expect(outcome.resolvedNodeId).toBeNull();
    expect(createMember).not.toHaveBeenCalled();
    expect(bindEmail).not.toHaveBeenCalled();
  });

  it('部门阶段超预算时不建号', async () => {
    const createMember = vi.fn();
    let clock = 0;
    const now = () => clock;
    const client = makeClient({
      createMember,
      bindEmail: vi.fn(),
      describeNodes: vi.fn(async () => {
        clock += 25_000;
        return { nodes: [ROOT, TEACH], truncated: false };
      }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput, now });

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('department_timeout');
    expect(createMember).not.toHaveBeenCalled();
  });

  it('邮箱已注册过其他账号 → needs_email，uin 保留', async () => {
    const client = makeClient({
      createMember: vi.fn().mockResolvedValue({ uin: '123456', requestId: 'r' }),
      bindEmail: vi
        .fn()
        .mockRejectedValue(new TencentApiError('FailedOperation.EmailAlreadyUsed', 'used', 'r')),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('needs_email');
    expect(outcome.uin).toBe('123456');
    expect(outcome.errorMessage).toContain('邮箱');
  });

  it('本成员已绑过邮箱且回查为 Success → active', async () => {
    const client = makeClient({
      createMember: vi.fn().mockResolvedValue({ uin: '123456', requestId: 'r' }),
      bindEmail: vi
        .fn()
        .mockRejectedValue(new TencentApiError('FailedOperation.MemberEmailExist', 'exist', 'r')),
      getEmailBindStatus: vi.fn().mockResolvedValue({ bindStatus: 'Success', requestId: 'r' }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('active');
    expect(outcome.uin).toBe('123456');
  });

  it('本成员已绑过邮箱但回查未完成 → failed，不得误判 needs_email', async () => {
    const client = makeClient({
      createMember: vi.fn().mockResolvedValue({ uin: '123456', requestId: 'r' }),
      bindEmail: vi
        .fn()
        .mockRejectedValue(new TencentApiError('FailedOperation.MemberEmailExist', 'exist', 'r')),
      getEmailBindStatus: vi.fn().mockResolvedValue({ bindStatus: 'Unbound', requestId: 'r' }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toContain('管理员');
  });

  it('手机号达上限 → needs_phone', async () => {
    const client = makeClient({
      createMember: vi.fn().mockResolvedValue({ uin: '123456', requestId: 'r' }),
      bindEmail: vi
        .fn()
        .mockRejectedValue(new TencentApiError('LimitExceeded.PhoneNumBound', 'phone', 'r')),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('needs_phone');
    expect(outcome.uin).toBe('123456');
  });

  it('建号报重名但 Remark 属于本单 → 复用 uin 继续绑定', async () => {
    const createMember = vi
      .fn()
      .mockRejectedValue(
        new TencentApiError('FailedOperation.OrganizationMemberNameUsed', 'used', 'r')
      );
    const bindEmail = vi.fn().mockResolvedValue({ bindId: 'b', requestId: 'r' });
    const client = makeClient({
      createMember,
      bindEmail,
      findMemberByName: vi.fn().mockResolvedValue({
        uin: '999',
        name: '张三-17915',
        remark: 'portal:7:17915',
      }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('active');
    expect(outcome.uin).toBe('999');
    expect(createMember).toHaveBeenCalledTimes(1);
    expect(bindEmail).toHaveBeenCalledWith(expect.objectContaining({ uin: '999' }));
  });

  it('建号报重名但 Remark 不属于本单 → failed，且不绑定邮箱', async () => {
    const bindEmail = vi.fn();
    const client = makeClient({
      createMember: vi
        .fn()
        .mockRejectedValue(
          new TencentApiError('FailedOperation.OrganizationMemberNameUsed', 'used', 'r')
        ),
      bindEmail,
      findMemberByName: vi.fn().mockResolvedValue({
        uin: '888',
        name: '张三-17915',
        remark: '',
      }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('failed');
    expect(outcome.errorMessage).toContain('成员名');
    expect(bindEmail).not.toHaveBeenCalled();
  });

  it('建号网络异常且回查不到 → failed + NetworkError', async () => {
    const client = makeClient({
      createMember: vi.fn().mockRejectedValue(new TencentApiError('NetworkError', 'boom')),
      bindEmail: vi.fn(),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('failed');
    expect(outcome.errorCode).toBe('NetworkError');
    expect(outcome.errorMessage).toContain('创建结果未确认');
  });

  it('建号超时但腾讯云其实已建好 → 按 Remark 复用 uin 继续绑定', async () => {
    const bindEmail = vi.fn().mockResolvedValue({ bindId: 'b', requestId: 'r' });
    const client = makeClient({
      createMember: vi.fn().mockRejectedValue(new TencentApiError('Timeout', 'timeout')),
      bindEmail,
      findMemberByName: vi.fn().mockResolvedValue({
        uin: '777',
        name: '张三-17915',
        remark: 'portal:7:17915',
      }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('active');
    expect(outcome.uin).toBe('777');
  });

  it('建号成功但没返回 Uin 时按名回查兜底', async () => {
    const client = makeClient({
      createMember: vi.fn().mockResolvedValue({ uin: '', requestId: 'r' }),
      bindEmail: vi.fn().mockResolvedValue({ bindId: 'b', requestId: 'r' }),
      findMemberByName: vi.fn().mockResolvedValue({
        uin: '666',
        name: '张三-17915',
        remark: 'portal:7:17915',
      }),
    });

    const outcome = await provisionApplication({ app: makeApp(), client, ...baseInput });

    expect(outcome.status).toBe('active');
    expect(outcome.uin).toBe('666');
  });
});
