import { NextResponse } from 'next/server';
import { ApiError, jsonError, requireOctafuseUserId, requireSession } from '@/lib/api/guard';
import { GatewayError } from '@/lib/gateway/client';
import { getOwnedRequestContent } from '@/lib/gateway/request-content';

/** 日志 id 只允许 URL 安全字符，超长直接拒掉，不原样转给网关 */
const LOG_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 单条调用的正文。
 *
 * 只读、只对本人的调用可见：先确认日志行属于当前用户，再向网关取正文。
 * 不存在与不属于本人一律 404，避免通过状态码探测他人日志。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const session = await requireSession(request);
    const userId = requireOctafuseUserId(session);

    const { id } = await context.params;
    const logId = id?.trim() ?? '';
    if (!LOG_ID_PATTERN.test(logId)) {
      throw new ApiError(400, '调用 ID 不合法', 'invalid_request');
    }

    const content = await getOwnedRequestContent(logId, userId);
    if (!content) throw new ApiError(404, '调用不存在', 'not_found');

    // 个人正文不进任何共享缓存
    return NextResponse.json(content, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    // 网关不可用与「不属于本人」必须区分：前者是 502，后者已在上面 404
    if (error instanceof GatewayError) {
      return jsonError(new ApiError(502, '暂时读不到调用正文，请稍后重试', 'gateway_unavailable'));
    }
    return jsonError(error);
  }
}
