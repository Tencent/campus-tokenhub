/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户管理员名单（`portal_shared.admins`）的只读访问。
 *
 * 为什么管理台要读门户的表：
 * - 门户的 `resolvePortalAdmin` 只认两个来源：本地引导账号 + **名单表**，
 *   名单是唯一可增删的权威来源（`ADMIN_EMAILS` 白名单已移除，owner 兜底也已移除）。
 * - 管理台原先读的是旧库表 `portal.member_admins`（新库里根本不存在），
 *   读不到就退回 `PORTAL_ADMIN_EMAILS` / `ONBOARDING_OWNER`，于是
 *   「在门户管理员页加进来的人」点进来必然被判 `not_admin`。
 *
 * 与门户共库（同一个 `DATABASE_URL` 数据库、不同 schema）是本模块的前提；
 * 不共库或非 Postgres 驱动时返回 `unavailable`，由调用方退回原有口径，不会更差。
 *
 * 刻意不缓存：门户增删名单即时生效，管理台也应一致；表很小（主键索引扫描）。
 */
import type { GatewayDatabaseClient } from '@octafuse/core';

/**
 * 与门户 `src/lib/config/tables.ts` 的 `ADMINS_TABLE` 保持一致。
 *
 * 历史上这里是旧库的 `portal.member_admins`（两站拆 schema 前的表名），
 * 拆库后共享层改名为 `portal_shared.admins`，这里没跟上——
 * 表现为管理台永远读不到名单、只能靠邮箱白名单放人。
 */
export const PORTAL_MEMBER_ADMINS_TABLE = 'portal_shared.admins';

/**
 * - `ok`：读到表，`subs` 可能为空数组（表在、但还没有管理员）
 * - `unavailable`：没给连接 / 非 Postgres 驱动 / 查询失败（表不存在、无权限、连不上）
 *
 * 两者必须区分：`ok` + 空数组表示「名单确实为空」，`unavailable` 表示「不知道」，
 * 后者要退回白名单与 owner 的旧口径。
 */
export type PortalAdminStoreResult =
	| { status: 'ok'; subs: string[] }
	| { status: 'unavailable'; reason: 'no_client' | 'driver' | 'query' };

export async function readPortalMemberAdminSubs(
	client?: GatewayDatabaseClient,
): Promise<PortalAdminStoreResult> {
	if (!client) return { status: 'unavailable', reason: 'no_client' };
	if (client.driver !== 'postgres') return { status: 'unavailable', reason: 'driver' };

	try {
		const rows = await client.raw<{ sub: string }[]>`
			select sub from portal_shared.admins
		`;
		const subs: string[] = [];
		for (const row of rows) {
			const sub = typeof row.sub === 'string' ? row.sub.trim() : '';
			if (sub) subs.push(sub);
		}
		return { status: 'ok', subs };
	} catch {
		return { status: 'unavailable', reason: 'query' };
	}
}
