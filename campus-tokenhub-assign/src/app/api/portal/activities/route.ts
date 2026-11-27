import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  jsonNoStore,
  requireOctafuseUserId,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { GatewayError } from '@/lib/gateway/client';
import { creditActivityReward, listActivityClaims } from '@/lib/activities/claims';
import { findActivity } from '@/lib/activities/overview';
import { readActivityConfig } from '@/lib/activities/store';
import { pointsToYuan, resolveActivityState } from '@/lib/activities/rules';

const STATE_ERROR: Record<string, { status: number; message: string; code: string }> = {
  claimed: { status: 409, message: '这个周期已经领过了，额度不会重复发放', code: 'activity_already_claimed' },
  'not-started': { status: 409, message: '活动还没开始', code: 'activity_not_started' },
  ended: { status: 409, message: '活动已结束', code: 'activity_ended' },
  closed: { status: 409, message: '今天不在可领取时间内', code: 'activity_closed' },
};

/**
 * 领取算力值。
 *
 * 三层防重复：
 * 1. 按钮在客户端置灰（体验层）；
 * 2. 这里先查网关加额流水，本周期已领直接 409（少打一次写接口，提示也更准）；
 * 3. 真正兜底的是网关加额幂等键 `external_ref`，并发点两次也只会入账一次。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    const userId = requireOctafuseUserId(session);

    const body = (await request.json().catch(() => null)) as { activityId?: unknown } | null;
    const activityId = typeof body?.activityId === 'string' ? body.activityId.trim() : '';
    if (!activityId) throw new ApiError(400, '缺少活动 ID', 'invalid_activity');

    // 以网关里保存的配置为准：被下架或已删除的活动不能再领。
    // 读库失败时**不能**回落到内置默认活动——那等于让已下架的活动继续发钱。
    const { activities: config, degraded } = await readActivityConfig();
    if (degraded) {
      throw new ApiError(503, '活动配置暂时不可用，请稍后重试', 'activity_config_unavailable');
    }
    const activity = findActivity(activityId, config);
    if (!activity) throw new ApiError(404, '活动不存在或已下架', 'activity_not_found');

    const now = Date.now();
    // 流水读失败不拦领取：网关幂等键仍然兜底，只是提示可能不如预检准
    const claims = await listActivityClaims(userId).catch(() => null);
    const claimedRefs = new Set((claims ?? []).map((claim) => claim.externalRef));
    const state = resolveActivityState(activity, claimedRefs, userId, now);

    if (state !== 'claimable') {
      const failure = STATE_ERROR[state] ?? STATE_ERROR.closed;
      throw new ApiError(failure.status, state === 'closed' ? activity.closedHint ?? failure.message : failure.message, failure.code);
    }

    const outcome = await creditActivityReward(userId, activity, now);

    audit('activity.claim', {
      actor_email: session.email,
      actor_external_id: session.sub,
      octafuse_user_id: userId,
      target: activity.id,
      result: outcome.status,
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return jsonNoStore({
      status: outcome.status,
      activity_id: activity.id,
      title: activity.title,
      points: activity.points,
      amount_yuan: pointsToYuan(activity.points),
      balance_yuan: outcome.balanceYuan,
    });
  } catch (error) {
    if (error instanceof GatewayError) {
      return jsonError(new ApiError(502, '领取暂时失败，请稍后重试', 'activity_claim_failed'));
    }
    return jsonError(error);
  }
}
