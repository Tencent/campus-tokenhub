/**
 * 「管理后台」入口：把门户会话换成带 `admin` 声明的会话，再送去管理台。
 *
 * 为什么需要这一跳：
 * - 管理台只认门户会话里的 `admin: true` 声明，而声明只在**签发**时写入；
 *   浏览器里已存在的会话（本次改动前签发的、或刚被加入管理员名单的）没有声明，
 *   直接点入口会被管理台判成 `not_admin`。
 * - 这里按**当前**的白名单/初始化 owner 重新判定并重签，旧会话也能一次点通。
 *
 * 非管理员一律 403：入口只对管理员渲染，直接访问不应拿到会话刷新。
 * 会话重签沿用原会话的剩余有效期，不因点击入口延长登录态。
 */
import { NextResponse } from 'next/server';
import { ApiError, requireSession } from '@/lib/api/guard';
import { resolvePortalAdmin, withAdminClaim } from '@/lib/auth/admin';
import { portalUrl } from '@/lib/auth/login';
import { buildSessionCookie, clearLegacyRootSessionCookie, signSession } from '@/lib/auth/session';
import { getConfig } from '@/lib/config';

const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

function page(title: string, body: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;padding:40px;line-height:1.7;color:#1f2328">
<h1 style="font-size:18px">${title}</h1>${body}</body></html>`;
}

export async function GET(request: Request): Promise<NextResponse> {
  const cfg = getConfig();
  const adminBase = cfg.portal.adminPublicBaseUrl;

  if (!adminBase) {
    return new NextResponse(
      page(
        '门户未配置管理后台地址',
        '<p>门户缺少 <code>ADMIN_PUBLIC_BASE_URL</code>，无法把浏览器送回管理后台。</p>' +
          '<p>请联系部署人员补上该项（例如 <code>https://zhiqi.woa.com/tokenhub/admin</code>）后重试。</p>'
      ),
      { status: 500, headers: HTML_HEADERS }
    );
  }

  let session: Awaited<ReturnType<typeof requireSession>>;
  try {
    session = await requireSession(request);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      return NextResponse.redirect(portalUrl(request, '/login?dest=admin'), 303);
    }
    throw error;
  }

  if (!(await resolvePortalAdmin(session))) {
    return new NextResponse(
      page(
        '当前账号无管理权限',
        '<p>只有全局管理员可以进入管理后台。</p>' +
          '<p>如需开通，请联系学校管理员在门户「管理员」页把你的账号加入管理员名单。</p>'
      ),
      { status: 403, headers: HTML_HEADERS }
    );
  }

  // 沿用原会话的剩余有效期；下限 1 分钟，避免临期会话签出立即过期的 token
  const remainingHours = Math.max((session.exp * 1000 - Date.now()) / 3_600_000, 1 / 60);
  const token = await signSession(
    await withAdminClaim({
      sub: session.sub,
      email: session.email,
      name: session.name,
      schoolName: session.school_name,
      octafuseUserId: session.octafuse_user_id,
    }),
    { ttlHours: remainingHours }
  );

  const cookie = buildSessionCookie(token);
  const response = NextResponse.redirect(adminBase, 303);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  // 顺手清掉旧版本写在根路径的那条（必须排在 cookies.set 之后）
  clearLegacyRootSessionCookie(response, cookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}
