import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireActivityAdmin } from '@/lib/activities/access';
import {
  ActivityConfigError,
  MAX_ACTIVITIES,
  normalizeActivityList,
  readActivityConfig,
  writeActivityConfig,
} from '@/lib/activities/store';

export const dynamic = 'force-dynamic';

/** 请求体 → 活动列表；校验失败统一转成 400，消息直接给管理员看 */
function readActivities(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, '请求体不是合法 JSON', 'invalid_body');
  }

  const raw = (body as Record<string, unknown>).activities;
  if (!Array.isArray(raw)) throw new ApiError(400, 'activities 应为数组', 'invalid_activities');
  if (raw.length > MAX_ACTIVITIES) {
    throw new ApiError(400, `最多配置 ${MAX_ACTIVITIES} 个活动`, 'too_many_activities');
  }

  try {
    return normalizeActivityList(raw);
  } catch (error) {
    if (error instanceof ActivityConfigError) {
      throw new ApiError(400, error.message, 'invalid_activity');
    }
    throw error;
  }
}

/** 当前生效的配置（网关未接管时是仓库默认值，页面据此提示）。 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['GET']);
    const session = await requireSession(request);
    await requireActivityAdmin(session);

    const state = await readActivityConfig();
    return NextResponse.json(state, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}

/** 覆盖写整份活动配置：先全量校验，再整份替换 `portal_assign.activity_configs`。 */
export async function PUT(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['PUT']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireActivityAdmin(session);

    const activities = readActivities(await request.json().catch(() => null));
    const saved = await writeActivityConfig(activities);

    audit('activity.config', {
      actor_email: session.email,
      actor_external_id: session.sub,
      target: 'activities',
      result: `saved:${saved.length}`,
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return NextResponse.json({ activities: saved, managed: true, degraded: false });
  } catch (error) {
    return jsonError(error);
  }
}
