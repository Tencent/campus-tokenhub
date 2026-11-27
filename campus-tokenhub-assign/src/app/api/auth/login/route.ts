import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { portalUrl, readAdminLoginTarget, sanitizeNextPath } from '@/lib/auth/login';
import { buildOidcTxCookie, createOidcTx, signOidcTx } from '@/lib/auth/providers/oidc';
import { authErrorCode, getAuthAdapter } from '@/lib/auth/providers/registry';
import { audit, clientIp } from '@/lib/audit';

/**
 * 发起登录：生成 state → 写 oidc_tx Cookie → 302 到认证方。
 *
 * 具体跳哪儿由适配器决定（`providers/registry.ts`）：
 * - `oauth2`：标准授权码 + PKCE，跳 IdP 授权端点；
 * - `cas`：直接跳 CAS Server 认证 URL。
 *
 * `dest=admin` 时 `next` 表示管理台内的深链接，登录成功后由回调跳回管理台；
 * 其余情况 `next` 仍是门户站内路径，默认落到当前模式的首页。
 */
export async function GET(request: Request): Promise<NextResponse> {
  const cfg = getConfig();

  let adapter: ReturnType<typeof getAuthAdapter>;
  try {
    adapter = getAuthAdapter(cfg);
  } catch {
    // 守卫拒绝非法 provider：不要 500，回登录页给可读错误并记审计
    audit('auth.login.fail', {
      result: 'auth_unsafe',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });
    const target = portalUrl(request, '/login');
    target.searchParams.set('error', 'auth_unsafe');
    return NextResponse.redirect(target, 303);
  }

  if (!adapter.requiresRedirect) {
    return NextResponse.redirect(portalUrl(request, '/login'), 303);
  }

  const url = new URL(request.url);
  const adminTarget = readAdminLoginTarget({
    dest: url.searchParams.get('dest'),
    next: url.searchParams.get('next'),
  });
  // 管理台目标下 next 已完全由 adminNext 承载，门户落点固定为默认首页
  const next = adminTarget ? '/overview' : sanitizeNextPath(
    url.searchParams.get('next'),
    '/overview'
  );
  const tx = await createOidcTx(next);
  if (adminTarget) {
    tx.dest = adminTarget.dest;
    tx.adminNext = adminTarget.adminNext;
  }
  const txCookie = buildOidcTxCookie(
    await signOidcTx(tx, cfg.auth.sessionSecret),
    cfg.auth.cookieSecure
  );

  let authorizationUrl: string;
  try {
    authorizationUrl = await adapter.start({ request, config: cfg, tx });
  } catch (error) {
    // 拿不到学校登录配置时不要 500，回登录页给出可读提示
    const code = authErrorCode(error) ?? 'login_start_failed';
    audit('auth.login.fail', {
      result: code,
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });
    const target = portalUrl(request, '/login');
    target.searchParams.set('error', code);
    return NextResponse.redirect(target, 303);
  }

  const response = NextResponse.redirect(authorizationUrl, 303);
  response.cookies.set(txCookie.name, txCookie.value, txCookie.options);
  return response;
}
