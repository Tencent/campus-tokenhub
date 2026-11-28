/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 后台应急账密登录：`POST` 校验 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 后写入 `admin_session`（httpOnly）。
 * `DELETE` 与 `/api/auth/logout` 类似，用于清除会话（兼容旧客户端可一并保留）。
 *
 * 默认关闭：`ADMIN_AUTH_MODE=portal` 且未显式 `ADMIN_PASSWORD_LOGIN=on` 时恒 403。
 * 门户已改用集成密钥 `Authorization: Bearer` 调 `/api/admin/*`，不再经过这里；
 * 人类正常登录走门户 SSO（`portal_session`）。这条通道只在 SSO 故障时由运维临时开启。
 */
import { generateSessionToken, hashSessionToken, resolveCookieSecure, timingSafeEqualSecret } from '@/lib/auth';
import { cookies } from 'next/headers';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import {
	checkLoginRateLimit,
	recordLoginFailure,
	resetLoginRateLimit,
} from '@/lib/login-rate-limit';
import { getClientIp, logAdminAuthEvent } from '@/lib/security-log';
import { resolveAdminAuthMode } from '@/lib/admin-auth-mode';
import {
	ADMIN_PASSWORD_LOGIN_ENV,
	resolveAdminPasswordLogin,
} from '@/lib/admin-password-policy';

export const dynamic = 'force-dynamic';

interface LoginRequest {
  username: string;
  password: string;
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as LoginRequest;
    const { username, password } = body;

    // 失败限速按来源 IP 计：拿不到 IP 时归到同一个桶（宁可多拦，也不放行无来源的爆破）
    const rateLimitKey = getClientIp(request) ?? 'unknown';
    const limit = checkLoginRateLimit(rateLimitKey);
    if (!limit.allowed) {
      logAdminAuthEvent('admin.auth.login_blocked', request, { username: String(username ?? '') });
      return Response.json(
        { success: false, message: '尝试过于频繁，请稍后再试' },
        { status: 429, headers: { 'retry-after': String(limit.retryAfterSeconds) } }
      );
    }

    // 凭据来自 OpenNext env；本地 dev 回退 process.env。
    // 默认留空 = 应急账密未配置；判定会返回干净的 403，不暴露服务器配置状态（也不返回 500）。
    let adminUsername = '';
    let adminPassword = '';

    try {
      const { env } = await import('@opennextjs/cloudflare').then(m => m.getCloudflareContext());
      adminUsername = env.ADMIN_USERNAME ?? '';
      adminPassword = env.ADMIN_PASSWORD ?? '';
    } catch {
      adminUsername = process.env.ADMIN_USERNAME ?? '';
      adminPassword = process.env.ADMIN_PASSWORD ?? '';
    }

    // portal 模式且 ADMIN_PASSWORD_LOGIN 未显式 on → 一律 403（默认安全）。
    // 应急回滚时显式设 ADMIN_AUTH_MODE=password/both 或 ADMIN_PASSWORD_LOGIN=on，
    // 并配置独立的 ADMIN_USERNAME / ADMIN_PASSWORD，重启管理台；用完把开关改回空。
    const decision = resolveAdminPasswordLogin({
      mode: resolveAdminAuthMode(),
      passwordLogin: process.env[ADMIN_PASSWORD_LOGIN_ENV],
      username: adminUsername,
      password: adminPassword,
    });
    if (!decision.allowed) {
      // 不计入失败限流：这是配置层面的拒绝，攻击者不该能用它把管理员刷进锁定状态
      logAdminAuthEvent('admin.auth.login_blocked', request, { username: String(username ?? '') });
      console.warn(`[admin] 账密登录已拒绝：${decision.reason}`);
      return Response.json(
        {
          success: false,
          code: decision.reason,
          message: '密码登录已关闭，请使用门户 SSO 登录',
        },
        { status: 403 }
      );
    }

    const passwordMatches = await timingSafeEqualSecret(String(password ?? ''), adminPassword);
    if (username !== adminUsername || !passwordMatches) {
      // 用户名不对也计数：否则可以先探账号再爆破
      recordLoginFailure(rateLimitKey);
      logAdminAuthEvent('admin.auth.login_failed', request, { username: String(username ?? '') });
      await new Promise(resolve => setTimeout(resolve, 1000));
      return Response.json(
        { success: false, message: 'Invalid credentials' },
        { status: 401 }
      );
    }

    resetLoginRateLimit(rateLimitKey);

    const sessionToken = generateSessionToken();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    const { storage } = await resolveAdminRequestRuntime(request);
    const now = new Date().toISOString();
    await storage.repositories.adminAccess.deleteExpiredSessions(now);
    await storage.repositories.adminAccess.insertSession({
      tokenHash: await hashSessionToken(sessionToken),
      username,
      createdAt: now,
      expiresAt: expiresAt.toISOString(),
    });

    const cookieStore = await cookies();
    cookieStore.set('admin_session', sessionToken, {
      httpOnly: true,
      secure: resolveCookieSecure(),
      sameSite: 'strict',
      expires: expiresAt,
      path: '/',
    });

    logAdminAuthEvent('admin.auth.login', request, { username });

    return Response.json({
      success: true,
      message: 'Login successful',
    });

  } catch (error) {
    console.error('Login API error:', error);
    return Response.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get('admin_session')?.value;
    if (token) {
      const { storage } = await resolveAdminRequestRuntime();
      await storage.repositories.adminAccess.deleteSession(await hashSessionToken(token));
    }
    cookieStore.delete('admin_session');

    logAdminAuthEvent('admin.auth.logout', request);

    return Response.json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    console.error('Logout API error:', error);
    return Response.json(
      { success: false, message: 'Internal server error' },
      { status: 500 }
    );
  }
}
