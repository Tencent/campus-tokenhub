/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `/api/auth/check` 的判定核心（供路由与测试共用）。
 *
 * 硬约束（design D5 / D8）：
 * - **永远返回 200**：compose 健康检查写死 `if (a.status !== 200) return bad(...)`，
 *   返回 503 会让容器 unhealthy，经依赖链把 portal 与 nginx 一起卡住。
 * - 每个分支都带 `authenticated`（健康检查还会在 body 里找这个字段）与 `mode`
 *   （前端据此决定渲染 SSO 屏还是回滚用的账密表单）。
 * - 区分 `not_admin`（会话有效但不是管理员）与 `sso_not_configured`（密钥缺失），
 *   两者都不能让前端自动跳转门户登录，否则会与仍有效的门户会话形成死循环。
 *
 * 凭证判定复用 `resolveAdminCredential`，与 `authenticateAdminRequest` 同一条路径。
 */
import type { GatewayDatabaseClient } from '@octafuse/core';
import type { AdminAuthMode } from '@/lib/admin-auth-mode';
import { adminAuthModeState, PORTAL_LOGIN_URL_ENV } from '@/lib/admin-auth-mode';
import { resolveAdminCredential, type AdminCredentialResolution } from '@/lib/auth';
import type { AdminAuthModeState } from '@/lib/admin-auth-mode';

type CheckRepositories = Parameters<typeof resolveAdminCredential>[0]['repositories'];

export type AdminAuthStateBody = {
	authenticated: boolean;
	mode: AdminAuthMode;
	loginUrl?: string;
	reason?: 'not_admin' | 'sso_not_configured';
	username?: string;
	via?: 'session' | 'portal';
};

export type AdminAuthStateInput = {
	adminSessionToken: string | null;
	portalSessionToken: string | null;
	repositories: CheckRepositories;
	/** 存储连接：用于读门户 `portal.member_admins` 名单；缺席时退回白名单/owner */
	client?: GatewayDatabaseClient;
	/** 测试注入模式状态；默认按当前环境解析 */
	modeState?: AdminAuthModeState;
	/** 测试注入当前时间（ISO） */
	now?: string;
	loginUrl?: string;
};

function readLoginUrl(): string | undefined {
	const value = (process.env[PORTAL_LOGIN_URL_ENV] ?? '').trim();
	return value || undefined;
}

export async function resolveAdminAuthState(input: AdminAuthStateInput): Promise<AdminAuthStateBody> {
	const modeState = input.modeState ?? adminAuthModeState();
	const loginUrl = input.loginUrl ?? readLoginUrl();

	const resolved: AdminCredentialResolution = await resolveAdminCredential({
		adminSessionToken: input.adminSessionToken,
		portalSessionToken: input.portalSessionToken,
		repositories: input.repositories,
		client: input.client,
		modeState,
		now: input.now,
	});

	const base = { mode: modeState.mode, ...(loginUrl ? { loginUrl } : {}) };

	if (resolved.principal) {
		return {
			authenticated: true,
			...base,
			...(resolved.username ? { username: resolved.username } : {}),
			...(resolved.via ? { via: resolved.via } : {}),
		};
	}

	return {
		authenticated: false,
		...base,
		...(resolved.reason ? { reason: resolved.reason } : {}),
	};
}
