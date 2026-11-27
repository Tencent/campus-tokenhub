import { describe, expect, it } from 'vitest';
import { toActivityClaim, listActivityClaims, creditActivityReward } from '@/lib/activities/claims';
import { claimExternalRef } from '@/lib/activities/rules';
import type { TokenActivityConfig } from '@/lib/activities/types';
import { fakeClient, wrap } from '../helpers/fake-client';

const now = Date.parse('2026-11-18T02:00:00Z');

const activity: TokenActivityConfig = {
  id: 'daily-recharge',
  title: '每日加油包',
  points: 500,
  summary: [],
  period: 'daily',
};

const claimRow = {
  id: 'audit-1',
  event_type: 'wallet_credit',
  change_payload: JSON.stringify({
    amount: 5,
    kind: 'signup_bonus',
    external_ref: claimExternalRef(activity.id, 'user-1', 'daily', now),
  }),
  created_at: '2026-11-18 09:00:00.000+00',
};

describe('toActivityClaim', () => {
  it('从审计流水的 change_payload 解析出活动与金额', () => {
    expect(toActivityClaim(claimRow)).toEqual({
      externalRef: claimExternalRef(activity.id, 'user-1', 'daily', now),
      activityId: 'daily-recharge',
      amountYuan: 5,
      claimedAt: '2026-11-18 09:00:00.000+00',
    });
  });

  it('change_payload 是对象、以及非活动发额都能处理', () => {
    expect(toActivityClaim({ ...claimRow, change_payload: JSON.parse(claimRow.change_payload) })?.activityId).toBe(
      'daily-recharge'
    );
    // 充值等非门户活动发放不算活动领取
    expect(
      toActivityClaim({ ...claimRow, change_payload: JSON.stringify({ amount: 100, external_ref: 'stripe_abc' }) })
    ).toBeNull();
    expect(toActivityClaim({ ...claimRow, change_payload: '{bad json' })).toBeNull();
    expect(toActivityClaim({ ...claimRow, change_payload: null })).toBeNull();
  });
});

describe('listActivityClaims', () => {
  it('只查 wallet_credit，并过滤掉非活动发放', async () => {
    const client = fakeClient(() =>
      wrap([
        claimRow,
        { id: 'audit-2', change_payload: JSON.stringify({ amount: 100, external_ref: 'stripe_abc' }) },
      ])
    );

    const claims = await listActivityClaims('user-1', client);

    expect(claims).toHaveLength(1);
    expect(claims[0].activityId).toBe('daily-recharge');
    expect(client.calls[0]).toMatchObject({
      channel: 'admin',
      path: '/api/admin/users/user-1/audit-logs',
      request: { query: { event_type: 'wallet_credit', page_size: 100 } },
    });
  });
});

describe('creditActivityReward', () => {
  it('按算力值换算金额，带幂等键加进永久额度', async () => {
    const client = fakeClient(() => ({
      success: true,
      status: 'applied',
      data: { status: 'applied', walletGranted: 25, walletSpent: 0, walletBalance: 25 },
    }));

    const result = await creditActivityReward('user-1', activity, now, client);

    expect(result).toEqual({ status: 'applied', balanceYuan: 25 });
    expect(client.calls[0].path).toBe('/api/admin/users/user-1/wallet/credit');
    expect(client.calls[0].request).toMatchObject({
      method: 'POST',
      body: {
        amount: 5,
        kind: 'signup_bonus',
        external_ref: claimExternalRef('daily-recharge', 'user-1', 'daily', now),
        reason: '算力加油包：每日加油包',
      },
    });
  });

  it('网关判定重复时返回 duplicate', async () => {
    const client = fakeClient(() => ({
      success: true,
      status: 'duplicate',
      data: { status: 'duplicate', walletBalance: 25 },
    }));

    await expect(creditActivityReward('user-1', activity, now, client)).resolves.toEqual({
      status: 'duplicate',
      balanceYuan: 25,
    });
  });
});
