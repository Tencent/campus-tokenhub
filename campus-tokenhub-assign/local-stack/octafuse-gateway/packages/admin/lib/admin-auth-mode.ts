/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台人类登录模式（`ADMIN_AUTH_MODE`）解析与可观测性。
 *
 * 取值：
 * - `portal`（默认）：人类只认门户会话；`Bearer` 管理密钥与 DB 会话仍可用于机器/应急。
 * - `password`：忽略门户会话，回到「共享账号密码」形态（回滚开关）。
 * - `both`：三种凭证都接受（灰度与回滚期用）。
 *
 * **缺密钥不阻塞进程启动**：compose 里 portal 与 nginx 都 `depends_on gateway-admin: service_healthy`，
 * 启动失败（或让 `/api/auth/check` 返回非 200）会连带把门户拖下水。这里只降级并留下可读日志。
 */
export const ADMIN_AUTH_MODE_ENV = 'ADMIN_AUTH_MODE';
export const PORTAL_SESSION_SECRET_ENV = 'PORTAL_SESSION_SECRET';
export const PORTAL_LOGIN_URL_ENV = 'PORTAL_LOGIN_URL';
export const PORTAL_LOGOUT_URL_ENV = 'PORTAL_LOGOUT_URL';

/** 与门户 `src/lib/config.ts` 的 SESSION_SECRET 长度校验保持一致。 */
const MIN_SECRET_LENGTH = 32;

export type AdminAuthMode = 'portal' | 'password' | 'both';

export type AdminAuthModeState = {
	mode: AdminAuthMode;
	/** 该模式是否接受门户会话（`password` 不接受）。 */
	portalRequested: boolean;
	/** 密钥就绪且模式允许，才真正启用门户会话分支。 */
	portalEnabled: boolean;
	/** 模式要求门户会话但密钥缺失/过短：属于配置错误，需要日志与 200 + reason 降级。 */
	ssoNotConfigured: boolean;
};

let warnedInvalidMode = false;
let warnedMissingSecret = false;

export function resolveAdminAuthMode(raw: string | undefined = process.env[ADMIN_AUTH_MODE_ENV]): AdminAuthMode {
	const value = (raw ?? '').trim().toLowerCase();
	if (value === 'portal' || value === 'password' || value === 'both') return value;
	if (value && !warnedInvalidMode) {
		warnedInvalidMode = true;
		console.warn(`[admin] ADMIN_AUTH_MODE=${value} 非法，已回退为 portal`);
	}
	return 'portal';
}

export function readPortalSessionSecret(): string {
	return (process.env[PORTAL_SESSION_SECRET_ENV] ?? '').trim();
}

export function adminAuthModeState(
	mode: AdminAuthMode = resolveAdminAuthMode(),
	secret: string = readPortalSessionSecret(),
): AdminAuthModeState {
	const portalRequested = mode !== 'password';
	const configured = secret.length >= MIN_SECRET_LENGTH;
	const portalEnabled = portalRequested && configured;
	const ssoNotConfigured = portalRequested && !configured;

	if (ssoNotConfigured && !warnedMissingSecret) {
		warnedMissingSecret = true;
		console.error(
			`[admin] ${PORTAL_SESSION_SECRET_ENV} 未配置或长度不足 ${MIN_SECRET_LENGTH}：管理台 SSO 不可用` +
				(mode === 'both' ? '（当前仅账密通道生效）' : '（当前无人能登录管理台，门户与 nginx 不受影响）') +
				`；请填入与门户 SESSION_SECRET 相同的值`,
		);
	}

	return { mode, portalRequested, portalEnabled, ssoNotConfigured };
}

/** 仅测试用：重置一次性告警状态 */
export function resetAdminAuthModeWarnings(): void {
	warnedInvalidMode = false;
	warnedMissingSecret = false;
}
