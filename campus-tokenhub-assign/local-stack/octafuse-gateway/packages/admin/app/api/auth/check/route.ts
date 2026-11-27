/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 供前端校验真实会话状态，并下发登录模式与门户登录地址。
 *
 * 判定逻辑在 `lib/admin-auth-state.ts`：与 `authenticateAdminRequest` 共用同一套凭证规则，
 * 且**每个分支都返回 200**（健康检查只接受 200，见 design D8）。
 */
import { cookies } from 'next/headers';
import { resolveAdminAuthState } from '@/lib/admin-auth-state';
import { resolveAdminRequestRuntime } from '@/lib/admin-request-runtime';

export const dynamic = 'force-dynamic';

export async function GET() {
	try {
		const cookieStore = await cookies();
		const { storage } = await resolveAdminRequestRuntime();
		const state = await resolveAdminAuthState({
			adminSessionToken: cookieStore.get('admin_session')?.value ?? null,
			portalSessionToken: cookieStore.get('portal_session')?.value ?? null,
			repositories: storage.repositories,
			client: storage.client,
		});
		return Response.json(state);
	} catch (error) {
		// 连库失败也要保持 200：否则健康检查会把容器判成 unhealthy
		console.error('Auth check error:', error);
		return Response.json(
			{ authenticated: false, mode: 'password' as const, reason: 'sso_not_configured' as const },
			{ status: 200 },
		);
	}
}
