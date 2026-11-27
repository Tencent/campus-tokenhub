/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 后台登出：清 `admin_session`，并在配置了 `PORTAL_LOGOUT_URL` 时代理门户登出，
 * 把门户返回的 `Set-Cookie` 透传给浏览器（清 `portal_session`）。
 *
 * 门户登出失败时返回 502：**不得**声称"已退出"（用户仍处于登录态）。
 * `DELETE` 保留旧行为（只清管理台会话），兼容既有调用方。
 */
import { cookies } from 'next/headers';
import { hashSessionToken } from '@/lib/auth';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';
import { proxyPortalLogout } from '@/lib/portal-logout';
import { logAdminAuthEvent } from '@/lib/security-log';

export const dynamic = 'force-dynamic';

async function clearAdminSession(): Promise<void> {
	const cookieStore = await cookies();
	const token = cookieStore.get('admin_session')?.value;
	if (token) {
		const { storage } = await resolveAdminRequestRuntime();
		await storage.repositories.adminAccess.deleteSession(await hashSessionToken(token));
	}
	cookieStore.delete('admin_session');
}

export async function POST(request: Request) {
	try {
		await clearAdminSession();

		const portal = await proxyPortalLogout({
			logoutUrl: process.env.PORTAL_LOGOUT_URL,
			cookieHeader: request.headers.get('cookie'),
		});

		if (!portal.ok) {
			// 事件枚举只到 logout：用 path 记录失败原因，便于日志检索
			logAdminAuthEvent('admin.auth.logout', request, { path: '/portal-logout-failed' });
			return Response.json({ success: false, message: portal.message }, { status: 502 });
		}

		logAdminAuthEvent('admin.auth.logout', request);
		const response = Response.json({
			success: true,
			message: 'Logout successful',
			portal: !portal.skipped,
		});
		for (const cookie of portal.setCookies) {
			response.headers.append('set-cookie', cookie);
		}
		return response;
	} catch (error) {
		console.error('Logout API error:', error);
		return Response.json({ success: false, message: 'Internal server error' }, { status: 500 });
	}
}

export async function DELETE(request: Request) {
	try {
		await clearAdminSession();
		logAdminAuthEvent('admin.auth.logout', request);
		return Response.json({ success: true, message: 'Logout successful' });
	} catch (error) {
		console.error('Logout API error:', error);
		return Response.json({ success: false, message: 'Internal server error' }, { status: 500 });
	}
}
