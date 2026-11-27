import { describe, expect, it } from 'vitest';
import {
  PROVISION_TIMEOUT_MS,
  SUBMIT_COOLDOWN_MS,
  assertTransition,
  buildMemberName,
  canDelete,
  canEditContact,
  canRetry,
  canSubmit,
  isRemoveInterrupted,
  cooldownRemainingMs,
  isProvisionInterrupted,
  parseUserId,
  validateContact,
} from '@/lib/members/rules';
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

const NOW = new Date('2026-11-18T10:00:00.000Z').getTime();

describe('parseUserId', () => {
  it('从 school_id:user_id 解析数字', () => {
    expect(parseUserId('7:17915')).toBe(17915);
  });

  it('非法输入抛错', () => {
    expect(() => parseUserId('17915')).toThrow('sub');
    expect(() => parseUserId('7:abc')).toThrow('sub');
  });
});

describe('buildMemberName', () => {
  it('中文姓名 + user_id', () => {
    expect(buildMemberName('张三', 17915)).toBe('张三-17915');
  });

  it('空格转连字符，非法字符被过滤', () => {
    expect(buildMemberName('张 三', 100)).toBe('张-三-100');
    expect(buildMemberName('李四（教务处）', 100)).toBe('李四教务处-100');
  });

  it('连续分隔符合并为一个', () => {
    expect(buildMemberName('张   三', 100)).toBe('张-三-100');
  });

  it('姓名过长时截断姓名，保留 -<user_id>', () => {
    const name = buildMemberName('非常非常非常非常非常长的老师姓名啊啊啊', 17915);
    expect(name.length).toBeLessThanOrEqual(25);
    expect(name.endsWith('-17915')).toBe(true);
  });

  it('姓名全为非法字符时退化为 user_id', () => {
    expect(buildMemberName('***', 17915)).toBe('17915');
  });
});

describe('canSubmit', () => {
  it('没有申请单可以提交', () => {
    expect(canSubmit(undefined)).toBe(true);
    expect(canSubmit(null)).toBe(true);
  });

  it('待审核 / 开通中 / 已开通拒绝', () => {
    expect(canSubmit(makeApp({ status: 'pending' }))).toBe(false);
    expect(canSubmit(makeApp({ status: 'provisioning' }))).toBe(false);
    expect(canSubmit(makeApp({ status: 'active' }))).toBe(false);
  });

  it('需换联系方式 / 已驳回 / 开通失败后可以重提', () => {
    expect(canSubmit(makeApp({ status: 'needs_email' }))).toBe(true);
    expect(canSubmit(makeApp({ status: 'needs_phone' }))).toBe(true);
    expect(canSubmit(makeApp({ status: 'rejected' }))).toBe(true);
    expect(canSubmit(makeApp({ status: 'failed' }))).toBe(true);
  });
});

describe('canEditContact', () => {
  it('pending 期间允许本人改错字', () => {
    expect(canEditContact(makeApp({ status: 'pending' }))).toBe(true);
  });

  it('需改资料 / 已驳回允许', () => {
    expect(canEditContact(makeApp({ status: 'needs_email' }))).toBe(true);
    expect(canEditContact(makeApp({ status: 'needs_phone' }))).toBe(true);
    expect(canEditContact(makeApp({ status: 'rejected' }))).toBe(true);
  });

  it('开通中 / 已开通 / 失败不允许只改联系方式', () => {
    expect(canEditContact(makeApp({ status: 'provisioning' }), NOW)).toBe(false);
    expect(canEditContact(makeApp({ status: 'active' }))).toBe(false);
    // 失败后走完整重新申请（可改部门），不走「只改联系方式」这条路
    expect(canEditContact(makeApp({ status: 'failed' }))).toBe(false);
  });

  it('开通中断超过阈值后允许本人补填（中断单自救）', () => {
    const fresh = makeApp({
      status: 'provisioning',
      provisioningStartedAt: new Date(NOW - 1_000).toISOString(),
    });
    expect(canEditContact(fresh, NOW)).toBe(false);

    const stale = makeApp({
      status: 'provisioning',
      provisioningStartedAt: new Date(NOW - PROVISION_TIMEOUT_MS - 1_000).toISOString(),
    });
    expect(canEditContact(stale, NOW)).toBe(true);
    expect(isProvisionInterrupted(stale, NOW)).toBe(true);

    // 缺时间戳时按「不确定」处理，不放行
    expect(canEditContact(makeApp({ status: 'provisioning' }), NOW)).toBe(false);
  });
});

describe('canRetry', () => {
  it('failed 可以重试', () => {
    expect(canRetry(makeApp({ status: 'failed' }), NOW)).toBe(true);
  });

  it('provisioning 未超时不可重试，超时后可重试', () => {
    const fresh = makeApp({
      status: 'provisioning',
      provisioningStartedAt: new Date(NOW - 1_000).toISOString(),
    });
    expect(canRetry(fresh, NOW)).toBe(false);

    const stale = makeApp({
      status: 'provisioning',
      provisioningStartedAt: new Date(NOW - PROVISION_TIMEOUT_MS - 1_000).toISOString(),
    });
    expect(canRetry(stale, NOW)).toBe(true);
  });

  it('provisioning 缺时间戳时按可重试处理（历史数据兜底）', () => {
    expect(canRetry(makeApp({ status: 'provisioning', provisioningStartedAt: null }), NOW)).toBe(
      true
    );
  });

  it('其他状态不可重试', () => {
    for (const status of ['pending', 'active', 'needs_email', 'needs_phone', 'rejected'] as MemberStatus[]) {
      expect(canRetry(makeApp({ status }), NOW)).toBe(false);
    }
  });
});

describe('cooldownRemainingMs', () => {
  it('刚失败后返回剩余时间', () => {
    const app = makeApp({
      status: 'needs_email',
      lastAttemptAt: new Date(NOW - 20_000).toISOString(),
    });
    expect(cooldownRemainingMs(app, NOW)).toBe(SUBMIT_COOLDOWN_MS - 20_000);
  });

  it('超过冷却期返回 0', () => {
    const app = makeApp({
      status: 'failed',
      lastAttemptAt: new Date(NOW - SUBMIT_COOLDOWN_MS - 1).toISOString(),
    });
    expect(cooldownRemainingMs(app, NOW)).toBe(0);
  });

  it('没有尝试记录返回 0', () => {
    expect(cooldownRemainingMs(undefined, NOW)).toBe(0);
    expect(cooldownRemainingMs(makeApp({ lastAttemptAt: null }), NOW)).toBe(0);
  });
});

describe('assertTransition', () => {
  it('正常链路合法', () => {
    expect(() => assertTransition('pending', 'provisioning')).not.toThrow();
    expect(() => assertTransition('provisioning', 'active')).not.toThrow();
    expect(() => assertTransition('needs_email', 'pending')).not.toThrow();
    expect(() => assertTransition('failed', 'provisioning')).not.toThrow();
    // 开通失败后本人重新发起申请
    expect(() => assertTransition('failed', 'pending')).not.toThrow();
    // 开通中断后本人补填资料，回到待审核
    expect(() => assertTransition('provisioning', 'pending')).not.toThrow();
  });

  it('已开通不可回到任何状态', () => {
    expect(() => assertTransition('active', 'pending')).toThrow('active');
    expect(() => assertTransition('active', 'provisioning')).toThrow('active');
  });

  it('已驳回不能直接开通', () => {
    expect(() => assertTransition('rejected', 'active')).toThrow('rejected');
  });
});

describe('validateContact', () => {
  it('合法输入通过', () => {
    expect(
      validateContact({ email: 'a.b@school.edu', countryCode: '86', phone: '13800000000' })
    ).toEqual({ ok: true, errors: {} });
  });

  it('邮箱格式非法', () => {
    const result = validateContact({ email: 'a@b', countryCode: '86', phone: '13800000000' });
    expect(result.ok).toBe(false);
    expect(result.errors.email).toBeTruthy();
  });

  it('手机号不是 6-15 位纯数字', () => {
    expect(
      validateContact({ email: 'a@b.com', countryCode: '86', phone: '123' }).errors.phone
    ).toBeTruthy();
    expect(
      validateContact({ email: 'a@b.com', countryCode: '86', phone: '1380000000000000' }).errors
        .phone
    ).toBeTruthy();
  });

  it('区号必须是数字', () => {
    expect(
      validateContact({ email: 'a@b.com', countryCode: 'zh', phone: '13800000000' }).errors
        .countryCode
    ).toBeTruthy();
  });
});

describe('常量', () => {
  it('冷却与超时阈值符合设计', () => {
    expect(SUBMIT_COOLDOWN_MS).toBe(60_000);
    expect(PROVISION_TIMEOUT_MS).toBe(120_000);
  });
});


describe('删除成员账号的状态机', () => {
  it('active 只能进 removing', () => {
    expect(() => assertTransition('active', 'removing')).not.toThrow();
    expect(() => assertTransition('active', 'deleted')).toThrow();
  });

  it('removing 可以完成，也可以因云侧失败回滚到 active', () => {
    expect(() => assertTransition('removing', 'deleted')).not.toThrow();
    expect(() => assertTransition('removing', 'active')).not.toThrow();
    // 删除中不允许跳去别处，否则中间态会被绕过
    expect(() => assertTransition('removing', 'pending')).toThrow();
  });

  it('deleted 允许重新申请（保留记录）', () => {
    expect(() => assertTransition('deleted', 'pending')).not.toThrow();
    expect(() => assertTransition('deleted', 'active')).toThrow();
  });

  it('只有 active 能删', () => {
    expect(canDelete(makeApp({ status: 'active' }))).toBe(true);
    for (const status of ['pending', 'provisioning', 'removing', 'deleted', 'failed', 'rejected'] as MemberStatus[]) {
      expect(canDelete(makeApp({ status })), status).toBe(false);
    }
  });

  it('删除中断超过阈值才可重试', () => {
    const now = 1_000_000;
    const fresh = makeApp({ status: 'removing', removingStartedAt: new Date(now - 1000).toISOString() });
    const stale = makeApp({
      status: 'removing',
      removingStartedAt: new Date(now - PROVISION_TIMEOUT_MS - 1000).toISOString(),
    });

    expect(isRemoveInterrupted(fresh, now)).toBe(false);
    expect(isRemoveInterrupted(stale, now)).toBe(true);
    // 非 removing 一律不算中断
    expect(isRemoveInterrupted(makeApp({ status: 'active' }), now)).toBe(false);
  });

  it('缺时间戳的历史数据按中断处理，避免永久卡住', () => {
    const app = makeApp({ status: 'removing', removingStartedAt: null, updatedAt: 'not-a-date' });
    expect(isRemoveInterrupted(app, Date.now())).toBe(true);
  });

  it('账号被删后可以重新提交申请', () => {
    expect(canSubmit(makeApp({ status: 'deleted' }))).toBe(true);
    expect(canSubmit(makeApp({ status: 'active' }))).toBe(false);
  });
});
