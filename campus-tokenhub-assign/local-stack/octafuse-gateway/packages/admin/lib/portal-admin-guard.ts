/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户 SSO 的「当前仍有权」复核。
 *
 * 门户会话里的 `admin: true` 是**签发时**的判定：把某人移出管理员名单之后，
 * 他手里已有的 portal_session 仍能通过验签，直到过期（默认 8 小时）。
 * 管理台每次请求按当前口径再判一次，避免撤权不生效。
 *
 * 判定与门户 `src/lib/auth/admin.ts` 的 `resolvePortalAdmin` 保持一致：
 * 1. 读到 `portal_shared.admins` 名单 → **只认名单**（命中放行，未命中拒绝）；
 * 2. 读不到名单（没连接 / 表缺失 / 查询失败）→ **直接拒绝**。不再回落
 *    `system_config.ONBOARDING_OWNER`：共库抖动时那是静默提权。
 *
 * 邮箱白名单（原 `PORTAL_ADMIN_EMAILS`）已移除：IdP 不返回邮箱时整条失效，
 * 而且邮箱可被改写，不该成为提权依据。管理员只有一个权威来源——名单表。
 */
import type { GatewayDatabaseClient } from '@octafuse/core';
import { readPortalMemberAdminSubs } from '@/lib/portal-admin-store';

type GuardRepositories = {
	systemConfig: {
		getConfig(key: string): Promise<string | null>;
	};
};

export async function isPortalAdminStillAllowed(
	principal: { sub: string; email: string },
	_repositories: GuardRepositories,
	client?: GatewayDatabaseClient,
): Promise<boolean> {
	const sub = principal.sub.trim();
	if (!sub) return false;

	// 名单是唯一权威来源，且**读不到即拒绝**（与门户 `resolvePortalAdmin` 的 fail-closed 口径一致）。
	// 曾经的「读不到就回落 system_config 的 ONBOARDING_OWNER」会在共库抖动时让旧 owner
	// 重新拿到管理台权限，属于静默提权；网关独立部署（无门户库）本来就不该用人类账号登录，
	// 那条路走 Bearer 管理密钥。
	const store = await readPortalMemberAdminSubs(client);
	if (store.status !== 'ok') return false;

	return store.subs.includes(sub);
}
