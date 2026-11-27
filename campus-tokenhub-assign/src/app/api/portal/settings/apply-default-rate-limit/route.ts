/**
 * 把「开户默认限流」补写到存量用户（一次性动作）。
 *
 * 与 `PUT /api/portal/settings` 分开是有意的：这是**写网关数据**的动作，不是改本地配置，
 * 放进同一个 PUT 会让「保存设置」变成一次不可预期的批量写。
 *
 * 守卫与设置写接口一致：同源校验 + 有效会话 + 设置管理员。
 */

import { NextResponse } from 'next/server';
import { ApiError, assertMethod, assertSameOrigin, jsonError, requireSession } from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireSettingsAdmin } from '@/lib/config/settings-access';
import {
  DefaultRateLimitMissingError,
  applyDefaultRateLimitToUsers,
} from '@/lib/gateway/rate-limit-defaults';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSettingsAdmin(session);

    // 请求体可选：`{ "overwrite": true }` 表示连已配置限流的用户一起刷新
    const body = (await request.json().catch(() => ({}))) as { overwrite?: unknown };
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') {
      throw new ApiError(400, 'overwrite 应为布尔值', 'invalid_overwrite');
    }

    let result;
    try {
      result = await applyDefaultRateLimitToUsers({ overwrite: body.overwrite === true });
    } catch (error) {
      if (error instanceof DefaultRateLimitMissingError) {
        throw new ApiError(400, error.message, 'default_rate_limit_missing');
      }
      throw error;
    }

    audit('config.change', {
      actor_external_id: session.sub,
      target: 'portal.settings.default_rate_limit',
      result: result.failed > 0 ? 'partial' : 'success',
      // overwrite=true 是「刷新已有数据」，审计里要能区分
      detail: (
        `overwrite=${result.overwrite} updated=${result.updated} overwritten=${result.overwritten} ` +
        `skipped=${result.skipped} failed=${result.failed}`
      ).slice(0, 200),
      ip: clientIp(request.headers),
    });

    return NextResponse.json(
      { success: true, ...result },
      { headers: { 'cache-control': 'no-store' } }
    );
  } catch (error) {
    return jsonError(error);
  }
}
