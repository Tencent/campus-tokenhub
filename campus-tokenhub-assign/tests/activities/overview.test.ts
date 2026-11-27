import { describe, expect, it } from 'vitest';
import {
  buildActivityViews,
  getActivityOverview,
  listActivities,
  summarizeClaims,
} from '@/lib/activities/overview';
import { claimExternalRef } from '@/lib/activities/rules';
import type { TokenActivityConfig } from '@/lib/activities/types';
import { fakeClient, wrap } from '../helpers/fake-client';

const now = Date.parse('2026-11-18T02:00:00Z');
const userId = 'user-1';

const activity: TokenActivityConfig = {
  id: 'daily-recharge',
  title: '每日加油包',
  points: 500,
  summary: ['每天可申领一次'],
  period: 'daily',
  ctaLabel: '领取',
};

const onceActivity: TokenActivityConfig = {
  id: 'new-model-trial',
  title: '新模型尝鲜',
  points: 2000,
  summary: [],
  badge: '限时抢领',
  period: 'once',
  featured: true,
};

describe('listActivities', () => {
  it('下架活动不展示也不发放', () => {
    const result = listActivities([activity, { ...onceActivity, enabled: false }]);
    expect(result.map((item) => item.id)).toEqual(['daily-recharge']);
  });
});

describe('buildActivityViews', () => {
  it('把状态换算成按钮文案与禁用态', () => {
    const ref = claimExternalRef(activity.id, userId, 'daily', now);
    const views = buildActivityViews([activity, onceActivity], new Set([ref]), userId, now);

    expect(views[0]).toMatchObject({
      id: 'daily-recharge',
      amountYuan: 5,
      state: 'claimed',
      disabled: true,
      buttonLabel: '今日已领',
      featured: false,
    });
    expect(views[1]).toMatchObject({
      id: 'new-model-trial',
      amountYuan: 20,
      state: 'claimable',
      disabled: false,
      buttonLabel: '立即领取',
      featured: true,
    });
  });
});

describe('summarizeClaims', () => {
  it('统计近一年次数与算力值，旧流水不计入', () => {
    const totals = summarizeClaims(
      [
        { externalRef: 'a', activityId: 'daily-recharge', amountYuan: 5, claimedAt: '2026-11-18 09:00:00.000+00' },
        { externalRef: 'b', activityId: 'new-model-trial', amountYuan: 20, claimedAt: '2026-10-01 09:00:00.000+00' },
        { externalRef: 'c', activityId: 'daily-recharge', amountYuan: 5, claimedAt: '2025-01-01 09:00:00.000+00' },
      ],
      [activity, onceActivity],
      now
    );

    expect(totals).toEqual({ points: 2500, count: 2 });
  });

  it('配置里已删除的旧活动按当时到账金额折算', () => {
    const totals = summarizeClaims(
      [{ externalRef: 'x', activityId: 'gone-activity', amountYuan: 3, claimedAt: null }],
      [activity],
      now
    );
    expect(totals).toEqual({ points: 300, count: 1 });
  });
});

describe('getActivityOverview', () => {
  it('读流水后标记已领取，并汇总近一年', async () => {
    const client = fakeClient(() =>
      wrap(
        [
          {
            id: 'audit-1',
            change_payload: JSON.stringify({
              amount: 5,
              external_ref: claimExternalRef('daily-recharge', userId, 'daily', now),
            }),
            created_at: '2026-11-18 09:00:00.000+00',
          },
        ],
        { total: 1 }
      )
    );

    const overview = await getActivityOverview(userId, now, client);
    const daily = overview.activities.find((item) => item.id === 'daily-recharge');

    expect(daily?.state).toBe('claimed');
    expect(overview.totals).toEqual({ points: 500, count: 1 });
    // 单测没有数据库：活动配置读取本身就是降级态（回落到内置清单），
    // `degraded` 现在同时覆盖「配置读失败」与「流水读失败」
    expect(overview.degraded).toBe(true);
  });

  it('读流水失败只降级，不影响活动展示', async () => {
    const client = fakeClient(() => new Error('gateway down'));

    const overview = await getActivityOverview(userId, now, client);

    expect(overview.degraded).toBe(true);
    expect(overview.totals).toEqual({ points: 0, count: 0 });
    expect(overview.activities.length).toBeGreaterThan(0);
    expect(overview.activities.every((item) => item.state === 'claimable')).toBe(true);
  });
});
