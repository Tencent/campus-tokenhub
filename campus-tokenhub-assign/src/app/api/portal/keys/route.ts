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
import { createKey, hasActiveKey, listKeys } from '@/lib/gateway/keys';
import { GatewayError } from '@/lib/gateway/client';

/** 列表：密钥页首屏用，未开户时返回空列表而不是报错 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(request);
    if (!session.octafuse_user_id) {
      return jsonNoStore({ ready: false, keys: [] });
    }

    const keys = await listKeys(session.octafuse_user_id);
    return jsonNoStore({ ready: true, keys });
  } catch (error) {
    return jsonError(error);
  }
}

/** 创建：先做「一人一把」二次校验，再建，最后写审计（不写明文） */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    const userId = requireOctafuseUserId(session);

    if (await hasActiveKey(userId)) {
      throw new ApiError(409, '你已有一把有效密钥，如需更换请先吊销', 'key_exists');
    }

    const name = `student-${session.sub}`.slice(0, 64);
    const created = await createKey(userId, name);

    audit('key.create', {
      actor_email: session.email,
      actor_external_id: session.sub,
      octafuse_user_id: userId,
      target: created.keyId,
      result: 'success',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return jsonNoStore({ key: created.key, key_id: created.keyId }, { status: 201 });
  } catch (error) {
    if (error instanceof GatewayError) {
      return jsonError(new ApiError(502, '密钥创建失败，请稍后重试', 'key_create_failed'));
    }
    return jsonError(error);
  }
}
