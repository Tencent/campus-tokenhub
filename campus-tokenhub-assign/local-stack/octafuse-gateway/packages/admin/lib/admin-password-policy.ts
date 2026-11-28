/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台「应急账密登录」的可用性判定（`ADMIN_AUTH_MODE` × `ADMIN_PASSWORD_LOGIN` × 口令强度）。
 *
 * 门户已改为用集成密钥（`Authorization: Bearer`）调用 `/api/admin/*`，不再需要账密登录换
 * `admin_session`；原先给门户留的 `x-tokenhub-portal-token` 内部后门已删除。
 * 现在 `/api/auth/login` 只服务「SSO 故障时的运维应急回滚」，默认关闭：公网请求打不开，
 * 持有 `SESSION_SECRET` 的内部调用者也不能绕过开关。
 *
 * 判定顺序即优先级：
 * 1. `portal` 模式且未显式 `ADMIN_PASSWORD_LOGIN=on` → 关闭（默认安全）；
 * 2. 口令是公开示例值 → 关掉所有模式（配置错误，必须先改口令）；
 * 3. `portal` 模式下口令过短同样拒绝；
 * 4. `password` / `both` 模式（运维显式选择的应急回滚路径）只在示例值上拒绝，不因长度拦截。
 */
import type { AdminAuthMode } from '@/lib/admin-auth-mode';

export const ADMIN_PASSWORD_LOGIN_ENV = 'ADMIN_PASSWORD_LOGIN';

/** 网关应急账密：16 位起（与门户的集成密钥完全独立） */
const MIN_PASSWORD_LENGTH = 16;

/** 开源后人人可见的示例口令（与 compose / `.env.example` 曾出现的默认值一致） */
const EXAMPLE_PASSWORD =
	/^(change-me|change_me|changeme|octafuse123|replace-me|password|passw0rd|admin$|123456|secret$)/i;

export type AdminPasswordLoginDenyReason =
	| 'disabled_by_mode'
	| 'weak_password'
	| 'unconfigured';

export type AdminPasswordLoginDecision =
	| { allowed: true }
	| { allowed: false; reason: AdminPasswordLoginDenyReason };

/** 显式开关：`on` / `true` / `1` 才算开启，其余（含拼错）一律按关闭处理 */
export function isAdminPasswordLoginEnabled(raw: string | null | undefined): boolean {
	const value = (raw ?? '').trim().toLowerCase();
	return value === 'on' || value === 'true' || value === '1';
}

/** 口令强度：只判「示例值 / 过短」，不做复杂度策略，避免把真实部署挡在门外 */
export function assessAdminPasswordStrength(
	password: string | null | undefined
): 'ok' | 'example' | 'too_short' {
	const value = (password ?? '').trim();
	if (!value) return 'too_short';
	if (EXAMPLE_PASSWORD.test(value)) return 'example';
	if (value.length < MIN_PASSWORD_LENGTH) return 'too_short';
	return 'ok';
}

/**
 * 判定本次请求是否允许走账密登录。
 *
 * 纯函数：模式、开关、凭据都由调用方注入，路由只负责把结果翻译成 HTTP 响应与日志。
 */
export function resolveAdminPasswordLogin(input: {
	mode: AdminAuthMode;
	passwordLogin?: string | null;
	username?: string | null;
	password?: string | null;
}): AdminPasswordLoginDecision {
	if (input.mode === 'portal' && !isAdminPasswordLoginEnabled(input.passwordLogin)) {
		return { allowed: false, reason: 'disabled_by_mode' };
	}

	if (!input.username || !input.password) {
		return { allowed: false, reason: 'unconfigured' };
	}

	const strength = assessAdminPasswordStrength(input.password);
	if (strength === 'example') return { allowed: false, reason: 'weak_password' };

	if (strength === 'too_short') {
		// portal 模式要求强口令；password / both 是运维显式选择的应急回滚路径，
		// 只拒绝公开示例值，不因为长度把回滚路径一起堵死。
		return input.mode === 'portal' ? { allowed: false, reason: 'weak_password' } : { allowed: true };
	}

	return { allowed: true };
}
