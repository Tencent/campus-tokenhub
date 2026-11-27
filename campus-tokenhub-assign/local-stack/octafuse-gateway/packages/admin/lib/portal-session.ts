/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户会话（`portal_session`）验签——管理台 SSO 的唯一人类身份来源。
 *
 * 与门户 `src/lib/auth/session.ts` 的契约必须保持一致：
 * HS256、`purpose=portal-session`、`sub` 非空、`admin=true` 才放行。
 * 只用 `crypto.subtle` 与 `atob`，不引入第三方依赖，Node 与 Worker 均可运行。
 *
 * 所有失败都返回**原因码**而不是抛异常：调用方据此决定 401 还是"配置未就绪"。
 */
export const PORTAL_SESSION_SECRET_ENV = 'PORTAL_SESSION_SECRET';

const PORTAL_SESSION_PURPOSE = 'portal-session';
const HMAC_ALG = { name: 'HMAC', hash: 'SHA-256' } as const;

export type PortalPrincipal = {
	sub: string;
	email: string;
	name: string;
};

export type PortalSessionFailure =
	| 'not_configured'
	| 'malformed'
	| 'bad_signature'
	| 'wrong_purpose'
	| 'expired'
	| 'not_admin';

export type PortalSessionResult =
	| { ok: true; principal: PortalPrincipal }
	| { ok: false; reason: PortalSessionFailure };

export type VerifyOptions = {
	/** 默认读 `PORTAL_SESSION_SECRET`；显式传空串视为未配置。 */
	secret?: string;
	/** 测试注入当前时间（毫秒）。 */
	now?: number;
};

function base64UrlToBytes(segment: string): ArrayBuffer | null {
	try {
		const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
		const raw = atob(padded);
		const bytes = new Uint8Array(raw.length);
		for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
		return bytes.buffer;
	} catch {
		return null;
	}
}

function decodeJsonSegment(segment: string): Record<string, unknown> | null {
	const buffer = base64UrlToBytes(segment);
	if (!buffer) return null;
	try {
		const parsed: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}

function readSecret(options: VerifyOptions): string {
	if (options.secret !== undefined) return options.secret.trim();
	return (process.env[PORTAL_SESSION_SECRET_ENV] ?? '').trim();
}

export async function verifyPortalSession(
	token: string | null | undefined,
	options: VerifyOptions = {},
): Promise<PortalSessionResult> {
	const secret = readSecret(options);
	if (!secret) return { ok: false, reason: 'not_configured' };
	if (!token) return { ok: false, reason: 'malformed' };

	const parts = token.trim().split('.');
	if (parts.length !== 3) return { ok: false, reason: 'malformed' };
	const [headerSegment, payloadSegment, signatureSegment] = parts;

	const header = decodeJsonSegment(headerSegment);
	const claims = decodeJsonSegment(payloadSegment);
	const signature = base64UrlToBytes(signatureSegment);
	// 只认 HS256：显式拒绝 none/RS256 等，避免算法替换
	if (!header || header.alg !== 'HS256') return { ok: false, reason: 'malformed' };
	if (!claims || !signature) return { ok: false, reason: 'malformed' };

	let signatureValid = false;
	try {
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			HMAC_ALG,
			false,
			['verify'],
		);
		signatureValid = await crypto.subtle.verify(
			HMAC_ALG,
			key,
			signature,
			new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
		);
	} catch {
		return { ok: false, reason: 'bad_signature' };
	}
	if (!signatureValid) return { ok: false, reason: 'bad_signature' };

	if (claims.purpose !== PORTAL_SESSION_PURPOSE) return { ok: false, reason: 'wrong_purpose' };

	const sub = typeof claims.sub === 'string' ? claims.sub.trim() : '';
	const exp = typeof claims.exp === 'number' ? claims.exp : Number.NaN;
	const nowSeconds = Math.floor((options.now ?? Date.now()) / 1000);

	if (!sub || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
	if (exp <= nowSeconds) return { ok: false, reason: 'expired' };
	if (claims.admin !== true) return { ok: false, reason: 'not_admin' };

	return {
		ok: true,
		principal: {
			sub,
			email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
			name: typeof claims.name === 'string' ? claims.name : '',
		},
	};
}
