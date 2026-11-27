import { describe, expect, it } from 'vitest';
import { describeStatus, mergeAdminCandidates } from '@/lib/members/presentation';
import type { MemberApplication, MemberStatus } from '@/lib/members/types';

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

const ALL: MemberStatus[] = [
  'pending',
  'provisioning',
  'active',
  'needs_email',
  'needs_phone',
  'failed',
  'rejected',
];

describe('describeStatus', () => {
  it('七个状态都有稳定的中文标题与说明', () => {
    const titles = ALL.map((status) => describeStatus(makeApp({ status })).title);
    expect(new Set(titles).size).toBe(ALL.length);
    for (const title of titles) {
      expect(title.length).toBeGreaterThan(1);
      expect(title).not.toMatch(/[A-Za-z]{4,}/);
    }
  });

  it('可编辑联系方式与规则一致', () => {
    expect(describeStatus(makeApp({ status: 'pending' })).canEditContact).toBe(true);
    expect(describeStatus(makeApp({ status: 'needs_email' })).canEditContact).toBe(true);
    expect(describeStatus(makeApp({ status: 'rejected' })).canEditContact).toBe(true);
    expect(describeStatus(makeApp({ status: 'active' })).canEditContact).toBe(false);
    expect(describeStatus(makeApp({ status: 'failed' })).canEditContact).toBe(false);
  });

  it('可重试与规则一致', () => {
    expect(describeStatus(makeApp({ status: 'failed' })).canRetry).toBe(true);
    expect(describeStatus(makeApp({ status: 'active' })).canRetry).toBe(false);
    expect(describeStatus(makeApp({ status: 'pending' })).canRetry).toBe(false);
  });

  it('已开通只提示查收激活邮件，不出现「已激活/待激活」', () => {
    const view = describeStatus(makeApp({ status: 'active', uin: '123456' }));
    expect(view.description).toContain('激活邮件');
    expect(view.description).not.toContain('已激活');
    expect(view.description).not.toContain('待激活');
  });

  it('失败态提示可自行重新提交，且不向老师暴露 RequestId 或错误码', () => {
    const view = describeStatus(
      makeApp({
        status: 'failed',
        errorCode: 'FailedOperation.CreateAccount',
        tencentRequestId: 'req-abc-123',
      })
    );
    expect(view.description).toContain('管理员');
    expect(view.description).toContain('重新提交');
    expect(view.description).not.toContain('req-abc-123');
    expect(view.description).not.toContain('FailedOperation');
  });

  it('邮箱不可用时不直接断言「已在腾讯云注册」（避免成为存在性探测器）', () => {
    const view = describeStatus(makeApp({ status: 'needs_email' }));
    expect(view.description).toContain('邮箱');
    expect(view.description).not.toContain('已注册过');
  });

  it('已驳回时展示驳回理由', () => {
    const view = describeStatus(makeApp({ status: 'rejected', reviewNote: '资料不全' }));
    expect(view.description).toContain('资料不全');
  });
});

describe('mergeAdminCandidates', () => {
  it('后到的无名项不覆盖已知姓名，并补上邮箱', () => {
    const merged = mergeAdminCandidates(
      [{ sub: '7:1', name: '张三', email: null, listed: true }],
      [{ sub: '7:1', name: '7:1', email: '张三.7-1@school.local', listed: true }]
    );

    expect(merged).toEqual([
      { sub: '7:1', name: '张三', email: '张三.7-1@school.local', listed: true },
    ]);
  });

  it('搜索结果里的新账号直接加入', () => {
    const merged = mergeAdminCandidates(
      [{ sub: '7:1', name: '张三', email: null, listed: true }],
      [{ sub: '7:2', name: '李四', email: '李四.7-2@school.local', listed: false }]
    );

    expect(merged.map((item) => item.sub)).toEqual(['7:1', '7:2']);
  });

  it('先前没有姓名时用后到的姓名补全', () => {
    const merged = mergeAdminCandidates(
      [{ sub: '7:1', name: '7:1', email: null, listed: true }],
      [{ sub: '7:1', name: '张三', email: null, listed: true }]
    );

    expect(merged[0].name).toBe('张三');
  });
});
