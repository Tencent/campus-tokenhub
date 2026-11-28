import { NextResponse, type NextRequest } from 'next/server';
import { getConfig } from '@/lib/config';
import { adminReturnUrl, establishSession, portalUrl, sanitizeNextPath } from '@/lib/auth/login';
import { buildSessionCookie, clearLegacyRootSessionCookie } from '@/lib/auth/session';
import { audit, clientIp } from '@/lib/audit';
import { provisionUser } from '@/lib/gateway/users';
import {
  OIDC_TX_COOKIE,
  clearOidcTxCookie,
  verifyOidcTx,
} from '@/lib/auth/providers/oidc';
import { authErrorCode, getAuthAdapter } from '@/lib/auth/providers/registry';
import { shouldForceSetup } from '@/lib/onboarding/access';
import { activityRecorder } from '@/lib/activity/recorder';

/**
 * 认证回调：校验 state → 换 token → 产出身份 → 开户 → 签发会话。
 *
 * 各协议只差「换 token 与取身份」那一步，由适配器处理；开户与签发会话完全共用。
 * 任何一步失败都回 /login?error=<code>，且不写会话 Cookie。
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cfg = getConfig();
  const url = new URL(request.url);
  const secure = cfg.auth.cookieSecure;
  const ua = request.headers.get('user-agent');
  const ip = clientIp(request.headers);

  const backToLogin = (code: string): NextResponse => {
    audit('auth.login.fail', { result: code, ip, ua });
    const target = portalUrl(request, '/login');
    target.searchParams.set('error', code);
    const response = NextResponse.redirect(target, 303);
    const txCookie = clearOidcTxCookie(secure);
    response.cookies.set(txCookie.name, txCookie.value, txCookie.options);
    return response;
  };

  let adapter: ReturnType<typeof getAuthAdapter>;
  try {
    adapter = getAuthAdapter(cfg);
  } catch {
    // 守卫拒绝非法 provider：走统一的回登录页 + 审计，不抛 500
    return backToLogin('auth_unsafe');
  }
  if (!adapter.requiresRedirect) {
    return backToLogin('callback_unavailable');
  }

  const tx = await verifyOidcTx(request.cookies.get(OIDC_TX_COOKIE)?.value, cfg.auth.sessionSecret);
  const callback = {
    code: url.searchParams.get('code'),
    state: url.searchParams.get('state'),
    ticket: url.searchParams.get('ticket'),
    token: url.searchParams.get('token'),
    error: url.searchParams.get('error'),
    errorDescription: url.searchParams.get('error_description'),
  };

  try {
    const identity = await adapter.complete({ request, config: cfg, tx, callback });

    // 首次登录顺带 get-or-create 开户；开户失败也照样签发会话（design D5）
    const sessionToken = await establishSession(identity, provisionUser);
    const sessionCookie = buildSessionCookie(sessionToken);

    audit('auth.login', {
      actor_email: identity.email,
      actor_external_id: identity.sub,
      result: 'success',
      ip,
      ua,
    });

    // 登录事件落库：内部 300ms 预算 + 告警节流。外层再包一层兜底：
    // 此时会话已经签发，埋点任何异常都不允许把登录打成失败。
    try {
      await activityRecorder.recordLogin({
        sub: identity.sub,
        name: identity.name,
        email: identity.email,
        method: adapter.kind,
      });
    } catch {
      // 静默：统计缺失优于登录失败
    }

    const txCookie = clearOidcTxCookie(secure);

    // 管理台目标：跳过初始化强制跳转，直接把管理员送回原页面。
    // 基址未配置时明确报错——绝不回落到容器内网地址（浏览器打不开）。
    if (tx?.dest === 'admin') {
      const adminTarget = adminReturnUrl(tx.adminNext);
      const response = adminTarget
        ? NextResponse.redirect(adminTarget, 303)
        : new NextResponse(adminBaseUrlMissingPage(), {
            status: 500,
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
      // 认证已经成功，会话照常写入：用户回门户仍可用
      response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.options);
      response.cookies.set(txCookie.name, txCookie.value, txCookie.options);
      // 顺手清掉旧版本写在根路径的那条（必须排在各 cookies.set 之后）
      clearLegacyRootSessionCookie(response, sessionCookie);
      return response;
    }

    // 未完成初始化时，把第一个登录的人直接带到 /setup（认领 owner 也在这一步）
    const forceSetup = await shouldForceSetup(identity.sub, identity.email);
    const target = forceSetup
      ? '/setup'
      : sanitizeNextPath(tx?.next, '/overview');

    // next 在签发时已 sanitize，这里再兜一次，避免 tx 被篡改成站外地址
    const response = NextResponse.redirect(portalUrl(request, target), 303);
    response.cookies.set(sessionCookie.name, sessionCookie.value, sessionCookie.options);

    response.cookies.set(txCookie.name, txCookie.value, txCookie.options);
    // 顺手清掉旧版本写在根路径的那条（必须排在各 cookies.set 之后）
    clearLegacyRootSessionCookie(response, sessionCookie);
    return response;
  } catch (error) {
    const code = authErrorCode(error) ?? 'login_failed';
    // 上游（IdP）的具体原因只进服务端日志：err_msg 常带内部字段名，不适合回显到登录页
    console.warn(
      `[auth] 登录失败 code=${code} reason=${error instanceof Error ? error.message : String(error)}`
    );
    return backToLogin(code);
  }
}

/** `dest=admin` 但管理台公网地址没配：给一页可读说明，而不是把管理员导向内网地址。 */
function adminBaseUrlMissingPage(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>管理后台地址未配置</title></head>
<body style="font-family:system-ui,-apple-system,'PingFang SC',sans-serif;padding:40px;line-height:1.7;color:#1f2329">
<h1 style="font-size:20px">管理后台地址未配置</h1>
<p>管理员身份已登录成功，但门户缺少 <code>ADMIN_PUBLIC_BASE_URL</code>，无法把浏览器送回管理后台。</p>
<p>请让部署方在门户环境变量中配置该地址（例如 <code>https://&lt;域名&gt;/tokenhub/admin</code>）后重试。</p>
<p><a href="/">返回门户首页</a></p>
</body></html>`;
}
