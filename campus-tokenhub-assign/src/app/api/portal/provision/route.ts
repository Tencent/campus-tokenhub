import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  jsonNoStore,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { buildSessionCookie, clearLegacyRootSessionCookie, signSession } from '@/lib/auth/session';
import { withAdminClaim } from '@/lib/auth/admin';
import { getUser, provisionUser } from '@/lib/gateway/users';

/**
 * 重试开户：会话照常有效，只是补上 `octafuse_user_id` 并重签 Cookie。
 * POST 开户是幂等的，多试几次没有副作用。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);

    if (session.octafuse_user_id) {
      // 已经开过：顺手确认真实状态，避免会话里的 ID 与网关不一致
      try {
        const user = await getUser(session.octafuse_user_id);
        return jsonNoStore({
          ok: true,
          octafuse_user_id: session.octafuse_user_id,
          status: user.status,
        });
      } catch {
        // 网关查不到就重新走一次幂等开户
      }
    }

    const result = await provisionUser({
      sub: session.sub,
      email: session.email,
      name: session.name,
    });

    if (!result.ok) {
      audit('provision.fail', {
        actor_email: session.email,
        actor_external_id: session.sub,
        // 真实的开户失败原因（网关登录被拒 / 超时 / 上游 HTTP 码）必须留痕，
        // 否则审计里只有一句 result=fail，等于没有线索（本次「门户与网关 admin
        // 的 SESSION_SECRET 不一致 → 登录 403」就是这么被藏起来的）。
        detail: result.error,
        result: 'fail',
        ip: clientIp(request.headers),
        ua: request.headers.get('user-agent'),
      });
      throw new ApiError(502, '账号开通失败，请稍后重试', 'provision_failed', {
        detail: result.error,
        // 管理员看得到原因（排查配置/密钥不一致全靠它），学生侧只留泛化文案
        exposeDetail: session.admin === true,
      });
    }

    const token = await signSession(
      await withAdminClaim({
        sub: session.sub,
        email: session.email,
        name: session.name,
        // 重签时保留登录时拿到的校名，否则开户成功后侧边栏会退回配置兜底
        schoolName: session.school_name,
        octafuseUserId: result.octafuseUserId,
      })
    );
    const cookie = buildSessionCookie(token);

    audit('provision.success', {
      actor_email: session.email,
      actor_external_id: session.sub,
      octafuse_user_id: result.octafuseUserId,
      result: 'success',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    const response = jsonNoStore({ ok: true, octafuse_user_id: result.octafuseUserId });
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    // 顺手清掉旧版本写在根路径的那条（必须排在 cookies.set 之后）
    clearLegacyRootSessionCookie(response, cookie);
    return response;
  } catch (error) {
    return jsonError(error);
  }
}
