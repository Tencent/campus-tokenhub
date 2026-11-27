/**
 * 企业微信 PC 扫码初始化：生成并签名 oidc_tx 事务，返回官方组件所需的公开参数。
 *
 * Secret 只用于内存中的配置判空，不写日志、不进响应；回调收尾仍走统一
 * `/api/auth/callback`，由企微适配器完成 gettoken / getuserinfo。
 */
import { NextResponse } from 'next/server';
import { authCallbackUrl, readAdminLoginTarget, sanitizeNextPath } from '@/lib/auth/login';
import { getConfig } from '@/lib/config';
import { buildOidcTxCookie, createOidcTx, signOidcTx } from '@/lib/auth/providers/oidc';

function errorResponse(error: string): NextResponse {
  return NextResponse.json(
    { error },
    { status: 400, headers: { 'cache-control': 'no-store' } }
  );
}

function parseOrigin(value: string | null): string | null {
  const raw = (value ?? '').trim();
  if (!raw || raw.toLowerCase() === 'null') return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

function hostFrom(value: string | null): string {
  // 反代链的 X-Forwarded-Host 可能是逗号分隔列表，只取最靠前的原始域名
  const raw = (value ?? '').split(',')[0]?.trim() ?? '';
  return raw.toLowerCase() === 'null' ? '' : raw;
}

/**
 * 按 Origin → X-Forwarded-Host → Host 取浏览器访问域名。
 * 后两者只有 host[:port]，用回调地址的协议补成 origin 再比较。
 * 该预检只用于 UX 提示（企微组件要求业务域名与 redirect_uri 域名一致），
 * 不承担安全职责；真正的回调仍由签名事务与后端配置保证。
 */
function requestOrigin(request: Request, callbackOrigin: URL): string | null {
  const fromOrigin = parseOrigin(request.headers.get('origin'));
  if (fromOrigin) return fromOrigin;

  const host =
    hostFrom(request.headers.get('x-forwarded-host')) || hostFrom(request.headers.get('host'));
  if (!host) return null;
  try {
    return new URL(`${callbackOrigin.protocol}//${host}`).origin;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const cfg = getConfig();
  if (cfg.auth.provider !== 'wecom') {
    return errorResponse('auth_unsafe');
  }

  const wecom = cfg.auth.wecom;
  if (!wecom.corpId?.trim() || !wecom.agentId?.trim() || !wecom.secret?.trim()) {
    return errorResponse('wecom_config_missing');
  }

  const redirectUri = authCallbackUrl(request);
  const callbackOrigin = new URL(redirectUri);
  const origin = requestOrigin(request, callbackOrigin);
  if (!origin || origin !== callbackOrigin.origin) {
    return errorResponse('wecom_qr_unavailable');
  }

  const url = new URL(request.url);
  const adminTarget = readAdminLoginTarget({
    dest: url.searchParams.get('dest'),
    next: url.searchParams.get('next'),
  });
  // 与发起登录路由同口径：管理台目标下门户落点固定为本站首页
  // （assign / member 的默认首页由 sanitizeNextPath 各自提供）
  const defaultNext = sanitizeNextPath(null);
  const next = adminTarget
    ? defaultNext
    : sanitizeNextPath(url.searchParams.get('next'), defaultNext);
  const tx = await createOidcTx(next);
  if (adminTarget) {
    tx.dest = adminTarget.dest;
    tx.adminNext = adminTarget.adminNext;
  }

  const txCookie = buildOidcTxCookie(
    await signOidcTx(tx, cfg.auth.sessionSecret),
    cfg.auth.cookieSecure
  );

  const response = NextResponse.json(
    {
      corpId: wecom.corpId,
      agentId: wecom.agentId,
      state: tx.state,
      redirectUri,
    },
    { status: 200, headers: { 'cache-control': 'no-store' } }
  );
  response.cookies.set(txCookie.name, txCookie.value, txCookie.options);
  return response;
}
