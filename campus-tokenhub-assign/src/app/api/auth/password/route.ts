/**
 * 引导期账号密码登录：只在「学校 SSO 未配齐」时可用。
 *
 * 存在意义：门户的配置入口 `/settings` 需要会话 + 管理员，而会话只能来自 SSO。
 * 学校还没对接 SSO 的部署需要一条能进门的路；一旦 SSO 必填项齐全，这条路必须立刻关掉，
 * 否则一份共享口令就能绕过学校统一认证（含其 MFA 与离校回收）。
 *
 * 处理顺序（任何一步失败都回登录页带错误码，绝不 500）：
 * 方法 → 同源 → 是否允许密码登录 → 按 IP 限流 → 校验口令 → 审计 → 签发会话 → 落地。
 */

import { NextResponse, type NextRequest } from 'next/server';
import { ApiError, assertSameOrigin } from '@/lib/api/guard';
import {
  adminReturnUrl,
  portalUrl,
  readAdminLoginTarget,
  sanitizeNextPath,
} from '@/lib/auth/login';
import { buildSessionCookie, clearLegacyRootSessionCookie, signSession } from '@/lib/auth/session';
import {
  localAdminIdentity,
  passwordLoginState,
  verifyLocalAdminCredentials,
} from '@/lib/auth/local-admin';
import {
  PasswordRateLimitError,
  assertPasswordLoginAllowed,
  recordPasswordLoginFailure,
  resetPasswordLoginFailures,
} from '@/lib/auth/password-rate-limit';
import { audit, clientIp } from '@/lib/audit';
import { activityRecorder } from '@/lib/activity/recorder';
import { getConfig } from '@/lib/config';
import { refreshConfigOverlay } from '@/lib/config/overlay';

/** 密码登录成功后的默认落点：引导期的唯一目的就是完成 SSO 对接 */
const DEFAULT_NEXT = '/settings';

function formValue(form: FormData | null, key: string): string {
  const value = form?.get(key);
  return typeof value === 'string' ? value : '';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // 处理顺序本身就是防护，调整前先读 tests/api/auth-password.test.ts 的顺序断言：
  //   1) 同源校验 —— 不读 body、不查库；
  //   2) 配置刷新 + 「是否允许密码登录」判定 —— 入口关着时连 body 都不解析；
  //   3) 按 IP 限流 —— 先于 multipart 解析，避免被大 body 打成内存/CPU 放大面；
  //   4) 解析 body 并校验口令。
  // 这条路由在 proxy 里是公开路径，任何人可提交任意大小的表单；旧顺序「先解析再判状态」
  // 等于给了一条不需要口令的资源消耗面。
  const ip = clientIp(request.headers);
  const ua = request.headers.get('user-agent');

  // body 解析前的失败也要能把用户带回原目标：先从 query 兜底，解析成功后再用表单值覆盖
  const queryNext = request.nextUrl.searchParams.get('next') ?? '';
  const queryDest = request.nextUrl.searchParams.get('dest') ?? '';
  let rawNext = queryNext;
  let rawDest = queryDest;

  // 失败一律回登录页：带上 next / dest 让用户停在原目标上重试
  const backToLogin = (code: string): NextResponse => {
    const target = portalUrl(request, '/login');
    target.searchParams.set('error', code);
    if (rawNext) target.searchParams.set('next', rawNext);
    if (rawDest) target.searchParams.set('dest', rawDest);
    return NextResponse.redirect(target, 303);
  };

  const fail = (code: string): NextResponse => {
    audit('auth.login.fail', { result: code, ip, ua });
    return backToLogin(code);
  };

  try {
    // 路由只导出 POST，其它方法由框架直接 405；这里只兜「跨站表单提交」
    assertSameOrigin(request);
  } catch (error) {
    // 同源校验失败：不比较口令、不签发会话，回到登录页给出可读提示
    if (error instanceof ApiError && error.code === 'origin_mismatch') return fail('origin_mismatch');
    throw error;
  }

  // 登录是安全决策点：先强制重读一次配置。
  // 内存快照有 30 秒 TTL，多副本时「刚在另一个副本把 SSO 配齐」的瞬间若用旧快照判定，
  // 会把已经该关闭的入口又放行一次。登录本身频率低，这次读库完全值得。
  await refreshConfigOverlay();
  const cfg = getConfig();

  const state = passwordLoginState(cfg);
  if (state !== 'available') {
    // disabled_by_switch 对调用方就是「这个入口关了」；unconfigured 单独给码，便于部署方区分
    return fail(state === 'unconfigured' ? 'password_unconfigured' : 'password_disabled');
  }

  const bucket = ip ?? '';
  try {
    assertPasswordLoginAllowed(bucket);
  } catch (error) {
    if (error instanceof PasswordRateLimitError) return fail('password_rate_limited');
    throw error;
  }

  const form = await request.formData().catch(() => null);
  rawNext = formValue(form, 'next') || queryNext;
  rawDest = formValue(form, 'dest') || queryDest;

  const username = formValue(form, 'username');
  const password = formValue(form, 'password');
  if (!verifyLocalAdminCredentials(cfg, username, password)) {
    recordPasswordLoginFailure(bucket);
    return fail('password_invalid');
  }
  resetPasswordLoginFailures(bucket);

  const identity = localAdminIdentity(cfg);
  if (!identity) {
    // 状态判定为 available 时不该走到这里；真走到了也不能签发一个无身份会话
    return fail('password_unconfigured');
  }

  const token = await signSession({
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    octafuseUserId: null,
    // 引导身份即管理员：设置页与设置接口都按全局管理员放行
    admin: true,
    loginMethod: 'password',
  });

  audit('auth.login', {
    actor_email: identity.email,
    actor_external_id: identity.sub,
    result: 'success',
    detail: 'password',
    ip,
    ua,
  });

  // 引导期账密登录同样计入活动：方法固定 password，写入失败不影响登录
  try {
    await activityRecorder.recordLogin({
      sub: identity.sub,
      name: identity.name,
      email: identity.email,
      method: 'password',
    });
  } catch {
    // 静默：会话已签发，埋点异常不能影响登录结果
  }

  // 管理台发起的登录：next 是管理台内深链接，基址未配置时留在门户设置页
  const adminTarget = readAdminLoginTarget({ dest: rawDest, next: rawNext });
  const adminUrl = adminTarget ? adminReturnUrl(adminTarget.adminNext) : null;
  const location = adminUrl ?? portalUrl(request, sanitizeNextPath(rawNext, DEFAULT_NEXT));

  const cookie = buildSessionCookie(token);
  const response = NextResponse.redirect(location, 303);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  // 顺手清掉旧版本写在根路径的那条（必须排在 cookies.set 之后）
  clearLegacyRootSessionCookie(response, cookie);
  response.headers.set('cache-control', 'no-store');
  return response;
}
