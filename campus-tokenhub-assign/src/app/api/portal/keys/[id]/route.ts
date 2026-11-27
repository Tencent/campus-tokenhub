import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireOctafuseUserId,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { GatewayError } from '@/lib/gateway/client';
import { listKeys, revokeKey } from '@/lib/gateway/keys';

/** 吊销密钥：404 由 gateway 层吞掉，对前端一律算成功 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    assertMethod(request, ['DELETE']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    const userId = requireOctafuseUserId(session);
    const { id } = await context.params;

    if (!id || id.length > 128) throw new ApiError(400, '密钥 ID 不合法', 'bad_request');

    // C2：网关的吊销端点是全局 keyId，没有归属校验。这里先按当前用户列出密钥，
    // 只放行属于自己的 id；不属于的一律 404（不回显「是否存在」），防止越权吊销他人密钥。
    const owned = await listKeys(userId);
    if (!owned.some((key) => key.id === id)) {
      throw new ApiError(404, '密钥不存在', 'key_not_found');
    }

    const { alreadyGone } = await revokeKey(id);

    audit('key.revoke', {
      actor_email: session.email,
      actor_external_id: session.sub,
      octafuse_user_id: userId,
      target: id,
      result: alreadyGone ? 'already_gone' : 'success',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return NextResponse.json({ ok: true, already_gone: alreadyGone });
  } catch (error) {
    if (error instanceof GatewayError) {
      return jsonError(new ApiError(502, '密钥吊销失败，请稍后重试', 'key_revoke_failed'));
    }
    return jsonError(error);
  }
}
