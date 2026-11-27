/**
 * 算力账户页的活动区数据组装：配置 + 领取流水 → 卡片视图。
 *
 * 取数失败只降级「已领取」标记，不整块消失：学生至少还能看到活动与规则。
 */

import { getGatewayClient, type GatewayClient } from '@/lib/gateway/client';
import { listActivityClaims, type ActivityClaimRecord } from './claims';
import {
  POINTS_PER_YUAN,
  activityButtonLabel,
  activityStatusLabel,
  resolveActivityState,
  withinLastYear,
} from './rules';
import { readActivityConfig } from './store';
import type { ActivityOverview, ActivityView, TokenActivityConfig } from './types';

/** 上架的活动（`enabled: false` 视为下架，既不展示也不再发放） */
export function listActivities(config: readonly TokenActivityConfig[]): TokenActivityConfig[] {
  return config.filter((activity) => activity.enabled !== false);
}

/** 领取接口用它校验活动是否存在/在架：下架的活动不能再领 */
export function findActivity(
  activityId: string,
  config: readonly TokenActivityConfig[]
): TokenActivityConfig | null {
  return listActivities(config).find((activity) => activity.id === activityId) ?? null;
}

export function buildActivityViews(
  activities: TokenActivityConfig[],
  claimedRefs: ReadonlySet<string>,
  userId: string,
  now: number
): ActivityView[] {
  return activities.map((activity) => {
    const state = resolveActivityState(activity, claimedRefs, userId, now);
    return {
      id: activity.id,
      title: activity.title,
      points: activity.points,
      amountYuan: Math.round((activity.points / POINTS_PER_YUAN) * 100) / 100,
      summary: activity.summary,
      badge: activity.badge,
      startsOn: activity.startsOn,
      endsOn: activity.endsOn,
      featured: activity.featured === true,
      state,
      disabled: state !== 'claimable',
      buttonLabel: activityButtonLabel(activity, state),
      statusLabel: activityStatusLabel(activity, state),
    };
  });
}

/**
 * 近一年累计：次数 + 算力值。
 *
 * 算力值优先按当前配置折算（活动改过价也能对上当下的口径）；
 * 配置里已经没有的旧活动，退回用当时实际到账金额折算。
 */
export function summarizeClaims(
  claims: ActivityClaimRecord[],
  activities: TokenActivityConfig[],
  now: number
): { points: number; count: number } {
  const byId = new Map(activities.map((activity) => [activity.id, activity]));
  let points = 0;
  let count = 0;

  for (const claim of claims) {
    if (!withinLastYear(claim.claimedAt, now)) continue;
    count += 1;
    const activity = byId.get(claim.activityId);
    points += activity ? activity.points : Math.round(claim.amountYuan * POINTS_PER_YUAN);
  }

  return { points, count };
}

export async function getActivityOverview(
  userId: string,
  now: number = Date.now(),
  client: GatewayClient = getGatewayClient()
): Promise<ActivityOverview> {
  // 配置以门户自己的 activity_configs 表为准；读不到时回退仓库默认配置。
  // 注意：`configDegraded` 必须一路带出去——读库失败却按内置活动发奖励，
  // 会让已下架的活动继续可领（见 /api/portal/activities 的拦截）。
  const { activities: config, degraded: configDegraded } = await readActivityConfig();
  const activities = listActivities(config);
  if (activities.length === 0) {
    return { activities: [], totals: { points: 0, count: 0 }, degraded: configDegraded };
  }

  let claims: ActivityClaimRecord[] = [];
  let degraded = false;
  try {
    claims = await listActivityClaims(userId, client);
  } catch {
    degraded = true;
  }

  const claimedRefs = new Set(claims.map((claim) => claim.externalRef));
  return {
    activities: buildActivityViews(activities, claimedRefs, userId, now),
    totals: summarizeClaims(claims, activities, now),
    degraded: degraded || configDegraded,
  };
}
