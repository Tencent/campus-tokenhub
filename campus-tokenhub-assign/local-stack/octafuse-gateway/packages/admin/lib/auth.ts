/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Gateway Admin 后台会话与外部 Admin API Key 的安全工具。
 */
import type { GatewayDatabaseClient, GatewayRepositories } from '@octafuse/core';
import type { AdminPrincipal } from '@/lib/admin-principal';
import { parseAdminPermissions } from '@/lib/admin-principal';
import { adminAuthModeState, readPortalSessionSecret } from '@/lib/admin-auth-mode';
import { isPortalAdminStillAllowed } from '@/lib/portal-admin-guard';
import { verifyPortalSession } from '@/lib/portal-session';

type AdminAuthenticationRepositories = {
	adminAccess: Pick<
		GatewayRepositories['adminAccess'],
		'getActiveApiKeyBySecret' | 'touchApiKey' | 'getValidSession'
	>;
	systemConfig: Pick<GatewayRepositories['systemConfig'], 'getConfig'>;
};

/** 生成 32 字节十六进制会话标识。 */
export function generateSessionToken(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function generateAdminApiKey(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return `sk-admin-${bytesToHex(bytes)}`;
}

export async function hashSessionToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return bytesToHex(new Uint8Array(digest));
}

/** Hash both values to a fixed length, then compare every byte without early exit. */
export async function timingSafeEqualSecret(left: string, right: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [leftHash, rightHash] = await Promise.all([
		crypto.subtle.digest('SHA-256', encoder.encode(left)),
		crypto.subtle.digest('SHA-256', encoder.encode(right)),
	]);
	const leftBytes = new Uint8Array(leftHash);
	const rightBytes = new Uint8Array(rightHash);
	let difference = 0;
	for (let index = 0; index < leftBytes.length; index += 1) {
		difference |= leftBytes[index] ^ rightBytes[index];
	}
	return difference === 0;
}

export function getSessionToken(request: Request): string | null {
	return readCookie(request, 'admin_session');
}

function readCookie(request: Request, name: string): string | null {
	const cookieHeader = request.headers.get('cookie');
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(';')) {
		const [key, ...rest] = part.trim().split('=');
		if (key === name) return decodeURIComponent(rest.join('='));
	}
	return null;
}

/**
 * 门户会话 Cookie（与门户同域共享，见 design D1）。
 *
 * 只读一条：旧版本写在 `Path=/` 的同名 Cookie 不做兼容——门户在登录 / 登出 /
 * 管理台入口都会把它删掉（见门户 `clearLegacyRootSessionCookie`），之后浏览器里
 * 只会剩 `Path=/tokenhub` 这一条。仍带旧 Cookie 的浏览器按「未登录」处理，
 * 重新登录一次即可。
 */
export function getPortalSessionToken(request: Request): string | null {
	return readCookie(request, 'portal_session');
}

/** 人类登录凭证的判定结果：`reason` 供 `/api/auth/check` 区分「不是管理员」与「没配密钥」。 */
export type AdminCredentialResolution = {
	principal: AdminPrincipal | null;
	via: 'session' | 'portal' | null;
	username: string | null;
	reason: 'not_admin' | 'sso_not_configured' | null;
};

/**
 * 人类凭证唯一判定入口：`admin_session`（有效才短路）→ 门户会话。
 *
 * `authenticateAdminRequest`（接口/实时通道）与 `/api/auth/check`（前端）**都必须**走这里，
 * 否则「页面能进、接口 401」会以两套判定逻辑的形式重现。
 */
export async function resolveAdminCredential(input: {
	adminSessionToken: string | null;
	portalSessionToken: string | null;
	repositories: AdminAuthenticationRepositories;
	/**
	 * 存储连接：用于读取门户 `portal.member_admins` 名单（与门户共库的前提）。
	 * 缺席时退回「邮箱白名单 / owner」的旧口径，见 `portal-admin-guard.ts`。
	 */
	client?: GatewayDatabaseClient;
	modeState?: ReturnType<typeof adminAuthModeState>;
	now?: string;
}): Promise<AdminCredentialResolution> {
	// DB 会话（机器登录 / 应急）：**只有有效时才短路**，无效必须继续尝试门户会话，
	// 否则浏览器里残留的过期 admin_session 会让已登录门户的管理员永远 401。
	if (input.adminSessionToken) {
		const tokenHash = await hashSessionToken(input.adminSessionToken);
		const session = await input.repositories.adminAccess.getValidSession(
			tokenHash,
			input.now ?? new Date().toISOString(),
		);
		if (session) {
			const username = session.username;
			return {
				principal: { type: 'console', id: `console:${username}`, username },
				via: 'session',
				username,
				reason: null,
			};
		}
	}

	const modeState = input.modeState ?? adminAuthModeState();
	if (modeState.ssoNotConfigured) {
		return { principal: null, via: null, username: null, reason: 'sso_not_configured' };
	}

	if (modeState.portalEnabled) {
		const portal = await verifyPortalSession(input.portalSessionToken, {
			secret: readPortalSessionSecret(),
		});
		if (portal.ok) {
			// 会话验签只证明「签发时是管理员」：撤权后旧 token 仍有效，这里按当前口径复核
			if (!(await isPortalAdminStillAllowed(portal.principal, input.repositories, input.client))) {
				return { principal: null, via: null, username: null, reason: 'not_admin' };
			}
			const username = portal.principal.email || portal.principal.sub;
			return {
				principal: { type: 'console', id: `console:${username}`, username },
				via: 'portal',
				username,
				reason: null,
			};
		}
		if (portal.reason === 'not_admin') {
			return { principal: null, via: null, username: null, reason: 'not_admin' };
		}
	}

	return { principal: null, via: null, username: null, reason: null };
}

/**
 * `authenticateAdminRequest` 的第二参只保留仓储，第三参传存储连接。
 *
 * 生产调用**必须**把 `storage.client` 带上：漏传会退回「只看邮箱白名单 / owner」的旧口径，
 * 于是门户管理员名单里的人仍然进不来。三个调用点（`/api/admin/[...path]`、
 * `admin-node-realtime`、`admin-realtime-worker`）都持有完整 `storage`。
 */
export async function authenticateAdminRequest(
	request: Request,
	repositories: AdminAuthenticationRepositories,
	client?: GatewayDatabaseClient
): Promise<AdminPrincipal | null> {
	const authorization = request.headers.get('authorization');
	if (authorization) {
		if (!authorization.startsWith('Bearer ')) return null;
		const secret = authorization.slice(7).trim();
		if (!secret) return null;
		const row = await repositories.adminAccess.getActiveApiKeyBySecret(secret);
		if (!row) return null;
		await repositories.adminAccess.touchApiKey(row.id);
		return {
			type: 'api_key',
			id: `admin_key:${row.id}`,
			keyId: row.id,
			permissions: parseAdminPermissions(row.permissionsJson),
		};
	}

	const resolved = await resolveAdminCredential({
		adminSessionToken: getSessionToken(request),
		portalSessionToken: getPortalSessionToken(request),
		repositories,
		client,
	});
	return resolved.principal;
}

/**
 * 是否为 `admin_session` 设置 `Secure`（可选加固，由 `ADMIN_COOKIE_SECURE` 控制）。
 * - 未设置或 `0`/`false`/`no`/`off` → false（默认；明文 HTTP 可登录）
 * - `1`/`true`/`yes`/`on` → true（已部署 HTTPS 时可选用，限制 Cookie 仅经 HTTPS 回传）
 */
export function resolveCookieSecure(): boolean {
  const raw = process.env.ADMIN_COOKIE_SECURE?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  return false;
}
