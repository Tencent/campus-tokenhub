import { NextResponse, type NextRequest } from 'next/server';
import { assertSameOrigin, jsonError } from '@/lib/api/guard';
import { portalUrl } from '@/lib/auth/login';
import { clearLegacyRootSessionCookie, clearSessionCookie, sessionFromCookieHeader } from '@/lib/auth/session';
import { revokeSessionsFor } from '@/lib/auth/revocation';

/**
 * 登出：清会话 Cookie + 吊销该用户已签发的会话。
 *
 * 只清 Cookie 不够：无状态 JWT 被复制走后，原持有人登出也无法止损。
 * 这里在服务端记一个吊销时间点，之后所有旧 token 在 `requireSession` /
 * `requireCurrentSession` 都会被判失效（等价于「登出所有设备」）。
 *
 * V1 不调 IdP 的 end_session；只接受 POST —— 避免被 <img src> 之类的 GET 请求顺手登出。
 * 另加同源校验：与其余写接口口径一致，挡住跨站表单的强制登出
 *（SameSite=Lax 已让跨站 POST 不带 Cookie，这层是纵深防御，不是唯一防线）。
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
  } catch (error) {
    // 来源不对就不跳转，直接按 API 错误回 403，避免把攻击者导向登录页
    return jsonError(error);
  }

  const cookie = clearSessionCookie();
  const response = NextResponse.redirect(portalUrl(request, '/login'), 303);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  // 顺手清掉旧版本写在根路径的那条（必须排在 cookies.set 之后）
  clearLegacyRootSessionCookie(response, cookie);

  // 吊销失败不能让登出失败：Cookie 已清掉，本浏览器已退出。
  // 同名 Cookie 可能并存（新旧 Path 各一个），必须逐个验签：`cookies.get()` 只取一条，
  // 拿到旧的那条会验签失败，导致本应吊销的会话没被吊销。
  const session = await sessionFromCookieHeader(request.headers.get('cookie')).catch(() => null);
  if (session) {
    await revokeSessionsFor(session.sub).catch(() => undefined);
  }

  return response;
}
