import { describe, expect, it } from 'vitest';
import {
  activityButtonLabel,
  activityStatusLabel,
  businessDay,
  claimExternalRef,
  claimPeriodKey,
  dayOfWeek,
  formatPoints,
  parseClaimRef,
  pointsToYuan,
  resolveActivityState,
  shiftDay,
  withinLastYear,
} from '@/lib/activities/rules';
import type { TokenActivityConfig } from '@/lib/activities/types';

/** 2026-11-18 10:00 北京时间（周三） */
const WEDNESDAY = Date.parse('2026-11-18T02:00:00Z');
/** 2026-11-22 10:00 北京时间（周日） */
const SUNDAY = Date.parse('2026-11-22T02:00:00Z');

const activity: TokenActivityConfig = {
  id: 'daily-recharge',
  title: '每日加油包',
  points: 500,
  summary: ['每天可申领一次'],
  period: 'daily',
};

describe('业务日期', () => {
  it('按 Asia/Shanghai 切日，UTC 前一天晚上算今天', () => {
    expect(businessDay(Date.parse('2026-11-17T16:30:00Z'))).toBe('2026-11-18');
    expect(businessDay(Date.parse('2026-11-17T15:59:00Z'))).toBe('2026-11-17');
  });

  it('星期与日期加减', () => {
    expect(dayOfWeek('2026-11-18')).toBe(3);
    expect(dayOfWeek('2026-11-22')).toBe(0);
    expect(dayOfWeek('bad')).toBe(-1);
    expect(shiftDay('2026-11-18', -2)).toBe('2026-11-16');
    expect(shiftDay('2026-12-01', -1)).toBe('2026-11-30');
  });
});

describe('领取周期键', () => {
  it('一次性活动恒为 once', () => {
    expect(claimPeriodKey('once', WEDNESDAY)).toBe('once');
    expect(claimPeriodKey('once', SUNDAY)).toBe('once');
  });

  it('每日 / 每周 / 每月各自收敛到同一周期', () => {
    expect(claimPeriodKey('daily', WEDNESDAY)).toBe('2026-11-18');
    expect(claimPeriodKey('weekly', WEDNESDAY)).toBe('w2026-11-16');
    // 周日仍属于本周（周一 11-16 开始）
    expect(claimPeriodKey('weekly', SUNDAY)).toBe('w2026-11-16');
    expect(claimPeriodKey('monthly', WEDNESDAY)).toBe('2026-11');
  });
});

describe('幂等键', () => {
  it('同一人同一周期稳定，跨周期变化', () => {
    const ref = claimExternalRef(activity.id, 'user-1', 'daily', WEDNESDAY);
    expect(ref).toBe('portal-activity/daily-recharge/user-1/2026-11-18');
    expect(claimExternalRef(activity.id, 'user-1', 'daily', WEDNESDAY + 1000)).toBe(ref);
    expect(claimExternalRef(activity.id, 'user-1', 'daily', SUNDAY)).not.toBe(ref);
    expect(claimExternalRef(activity.id, 'user-2', 'daily', WEDNESDAY)).not.toBe(ref);
  });

  it('能从键里认出活动，非活动键返回 null', () => {
    const ref = claimExternalRef(activity.id, 'user-1', 'once', WEDNESDAY);
    expect(parseClaimRef(ref)).toEqual({ activityId: 'daily-recharge' });
    expect(parseClaimRef('stripe_session_abc')).toBeNull();
    expect(parseClaimRef('portal-activity/only-id')).toBeNull();
  });
});

describe('算力值换算', () => {
  it('100 算力值 = 1 元，保留两位小数', () => {
    expect(pointsToYuan(2000)).toBe(20);
    expect(pointsToYuan(500)).toBe(5);
    expect(pointsToYuan(150)).toBe(1.5);
    expect(pointsToYuan(1)).toBe(0.01);
    expect(pointsToYuan(Number.NaN)).toBe(0);
  });

  it('展示用千分位', () => {
    expect(formatPoints(130000)).toBe('130,000');
    expect(formatPoints(500)).toBe('500');
  });
});

describe('卡片状态', () => {
  const ref = claimExternalRef(activity.id, 'user-1', 'daily', WEDNESDAY);

  it('没领过且时间窗内可领', () => {
    expect(resolveActivityState(activity, new Set(), 'user-1', WEDNESDAY)).toBe('claimable');
    expect(activityButtonLabel(activity, 'claimable')).toBe('立即领取');
    expect(activityStatusLabel(activity, 'claimable')).toBeNull();
  });

  it('本周期领过就是 claimed', () => {
    expect(resolveActivityState(activity, new Set([ref]), 'user-1', WEDNESDAY)).toBe('claimed');
    expect(activityButtonLabel(activity, 'claimed')).toBe('今日已领');
    expect(activityButtonLabel({ ...activity, period: 'once' }, 'claimed')).toBe('已领取');
  });

  it('时间窗优先于领取记录', () => {
    const windowed: TokenActivityConfig = { ...activity, startsOn: '2026-11-20', endsOn: '2026-11-30' };
    expect(resolveActivityState(windowed, new Set([ref]), 'user-1', WEDNESDAY)).toBe('not-started');
    expect(activityStatusLabel(windowed, 'not-started')).toBe('2026-11-20 开始');

    const ended: TokenActivityConfig = { ...activity, endsOn: '2026-11-17' };
    expect(resolveActivityState(ended, new Set(), 'user-1', WEDNESDAY)).toBe('ended');
    expect(activityButtonLabel(ended, 'ended')).toBe('已结束');
  });

  it('结束日当天仍可领', () => {
    const endsToday: TokenActivityConfig = { ...activity, endsOn: '2026-11-18' };
    expect(resolveActivityState(endsToday, new Set(), 'user-1', WEDNESDAY)).toBe('claimable');
  });

  it('限定星期时非可领日返回 closed', () => {
    const weekend: TokenActivityConfig = {
      ...activity,
      weekdays: [0, 6],
      closedHint: '周六、周日可领',
    };
    expect(resolveActivityState(weekend, new Set(), 'user-1', WEDNESDAY)).toBe('closed');
    expect(activityStatusLabel(weekend, 'closed')).toBe('周六、周日可领');
    expect(resolveActivityState(weekend, new Set(), 'user-1', SUNDAY)).toBe('claimable');
  });
});

describe('近一年窗口', () => {
  it('一年内的流水计入，超出不算，时间缺失按计入处理', () => {
    expect(withinLastYear('2026-10-01 00:00:00.000+00', WEDNESDAY)).toBe(true);
    expect(withinLastYear('2025-10-01 00:00:00.000+00', WEDNESDAY)).toBe(false);
    expect(withinLastYear(null, WEDNESDAY)).toBe(true);
    expect(withinLastYear('not-a-time', WEDNESDAY)).toBe(true);
  });
});
