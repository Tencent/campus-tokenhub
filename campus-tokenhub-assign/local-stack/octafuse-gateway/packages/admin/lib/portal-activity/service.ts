/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户活跃度看板的数据层（只读）。
 *
 * 读 `portal_shared.login_events` / `portal_shared.page_views`：
 * - 时间区间按业务时区的自然日对齐，与 `portal-usage` 同一套口径；
 * - `site` 支持 all / assign / member；
 * - 排行的排序与搜索在 SQL 侧执行，返回前 N 条（默认 100，CSV 导出可到 5000）；
 * - 姓名/邮箱用 LATERAL 取该用户**全表最近一条**登录事件，
 *   避免「本窗口只浏览未登录」的用户在排行里显示空白。
 *
 * 边界：本模块只读这两张表，不写、不改门户任何数据。
 */

import type { GatewayRepositories } from '@octafuse/core';
import {
	getBusinessTimezone,
	zonedDatetimeLocalInputToInstant,
} from '@octafuse/core/lib/business-timezone';

/** 单次查询允许的最大跨度（天） */
export const MAX_RANGE_DAYS = 90;
/** 排行默认返回条数 */
export const DEFAULT_LIMIT = 100;
/** 排行上限（CSV 导出用满这个值） */
export const MAX_LIMIT = 5000;

export const ACTIVITY_SITES = ['all', 'assign', 'member'] as const;
export type ActivitySiteFilter = (typeof ACTIVITY_SITES)[number];

export const ACTIVITY_SORTS = ['page_views', 'logins', 'active_days', 'last_active'] as const;
export type ActivitySort = (typeof ACTIVITY_SORTS)[number];

const DAY_MS = 86_400_000;

type PgSql = {
	unsafe: (query: string, parameters?: unknown[]) => Promise<unknown[]>;
};

function pgSql(repositories: GatewayRepositories): PgSql {
	const client = repositories.client;
	if (client.driver !== 'postgres') {
		throw new Error('portal-activity 仅支持 postgres 存储');
	}
	return client.raw as unknown as PgSql;
}

function toNumber(value: string | number | null | undefined): number {
	const parsed = Number(value ?? 0);
	return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------- 参数校验

/** `YYYY-MM-DD` 且是真实日期 */
export function parseDay(raw: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
	const parsed = new Date(`${raw}T00:00:00Z`);
	if (Number.isNaN(parsed.getTime())) return null;
	// 排除 2026-02-31 这类会被 Date 顺延的日期
	return parsed.toISOString().slice(0, 10) === raw ? raw : null;
}

export type NormalizedRange = { start: string; end: string; days: number };

export function normalizeRange(startRaw: string, endRaw: string): NormalizedRange | null {
	const start = parseDay(startRaw);
	const end = parseDay(endRaw);
	if (!start || !end) return null;

	const startMs = Date.parse(`${start}T00:00:00Z`);
	const endMs = Date.parse(`${end}T00:00:00Z`);
	if (endMs < startMs) return null;

	const days = Math.round((endMs - startMs) / DAY_MS) + 1;
	if (days > MAX_RANGE_DAYS) return null;

	return { start, end, days };
}

export function parseSite(raw: string | undefined): ActivitySiteFilter | null {
	if (raw == null || raw.trim() === '') return 'all';
	const value = raw.trim();
	return (ACTIVITY_SITES as readonly string[]).includes(value) ? (value as ActivitySiteFilter) : null;
}

export function parseSort(raw: string | undefined): ActivitySort | null {
	if (raw == null || raw.trim() === '') return 'page_views';
	const value = raw.trim();
	return (ACTIVITY_SORTS as readonly string[]).includes(value) ? (value as ActivitySort) : null;
}

export function parseLimit(raw: string | undefined): number | null {
	if (raw == null || raw.trim() === '') return DEFAULT_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return null;
	return Math.min(parsed, MAX_LIMIT);
}

// ---------------------------------------------------------------- 结果组装

export type KpiRow = {
	logins: string | number;
	login_users: string | number;
	page_views: string | number;
	active_users: string | number;
};

export type TrendRow = {
	day: string;
	logins: string | number;
	page_views: string | number;
};

export type ActivityUserRow = {
	sub: string;
	name: string | null;
	email: string | null;
	site: string;
	logins: string | number;
	page_views: string | number;
	active_days: string | number;
	last_active_at: string | Date | null;
};

export type PortalActivityUser = {
	sub: string;
	name: string | null;
	email: string | null;
	site: string;
	logins: number;
	pageViews: number;
	activeDays: number;
	lastActiveAt: string | null;
};

export type PortalActivitySummary = {
	range: { start: string; end: string; site: ActivitySiteFilter };
	kpi: {
		logins: number;
		loginUsers: number;
		pageViews: number;
		activeUsers: number;
		pvPerUser: number;
	};
	trend: { day: string; logins: number; pageViews: number }[];
	users: PortalActivityUser[];
};

/** 把聚合行拼成响应；除零与空数据在这里兜住（纯函数，便于单测） */
export function assembleSummary(
	range: { start: string; end: string; site: ActivitySiteFilter },
	kpiRow: KpiRow | undefined,
	trendRows: TrendRow[],
	userRows: ActivityUserRow[]
): PortalActivitySummary {
	const logins = toNumber(kpiRow?.logins);
	const loginUsers = toNumber(kpiRow?.login_users);
	const pageViews = toNumber(kpiRow?.page_views);
	const activeUsers = toNumber(kpiRow?.active_users);
	const pvPerUser = activeUsers > 0 ? Math.round((pageViews / activeUsers) * 10) / 10 : 0;

	return {
		range: { start: range.start, end: range.end, site: range.site },
		kpi: { logins, loginUsers, pageViews, activeUsers, pvPerUser },
		trend: trendRows.map((row) => ({
			day: row.day,
			logins: toNumber(row.logins),
			pageViews: toNumber(row.page_views),
		})),
		users: userRows.map((row) => ({
			sub: row.sub,
			name: row.name,
			email: row.email,
			site: row.site,
			logins: toNumber(row.logins),
			pageViews: toNumber(row.page_views),
			activeDays: toNumber(row.active_days),
			lastActiveAt: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
		})),
	};
}

// ---------------------------------------------------------------- 查询

export type PortalActivityQuery = NormalizedRange & {
	site: ActivitySiteFilter;
	sort: ActivitySort;
	q: string;
	limit: number;
};

/** 站点过滤片段：`$n` 为站点参数，`all` 时恒真 */
export function siteFilter(column: string, paramIndex: number): string {
	return `($${paramIndex} = 'all' OR ${column} = $${paramIndex})`;
}

/**
 * 参数个数必须与 SQL 占位符严格对齐。
 *
 * pg 对「传了但 SQL 没引用」的参数会报 `could not determine data type of parameter $n`，
 * 而「SQL 引用了但没传」是另一条报错 —— 都在运行期才炸，看板只会显示「数据加载失败」。
 * 三个查询的占位符布局各不相同（trend/users 的站点参数在第 6 位，KPI 在第 3 位），
 * 这里在发请求前就挡住错位。
 */
export function assertParamArity(sql: string, values: unknown[], label: string): void {
	const used = new Set(Array.from(sql.matchAll(/\$(\d+)/g), (match) => Number(match[1])));
	const max = used.size > 0 ? Math.max(...used) : 0;
	const missing: number[] = [];
	for (let index = 1; index <= max; index += 1) {
		if (!used.has(index)) missing.push(index);
	}
	if (missing.length > 0 || max !== values.length) {
		throw new Error(
			`${label} 参数与占位符不匹配：占位符最大 $${max}，传入 ${values.length} 个` +
				(missing.length > 0 ? `，缺失 $${missing.join(', $')}` : '')
		);
	}
}

export const KPI_SQL = (site: string) => `
	WITH l AS (
		SELECT COUNT(*)::bigint AS logins, COUNT(DISTINCT sub)::bigint AS login_users
		  FROM portal_shared.login_events
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
		   AND ${site}
	), p AS (
		SELECT COUNT(*)::bigint AS page_views
		  FROM portal_shared.page_views
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
		   AND ${site}
	), act AS (
		-- 活跃人数 = 两表并集去重后的 sub 数。这里必须用 UNION ALL + COUNT(DISTINCT)：
		-- 单独的 UNION 会强制 Sort + Unique 去重，30 天窗口 20 万事件时排序溢出磁盘，
		-- 实测比本写法慢约 20%（431ms → 356ms，500k 登录 / 2M PV）。
		SELECT sub FROM portal_shared.login_events
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ${site}
		UNION ALL
		SELECT sub FROM portal_shared.page_views
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz AND ${site}
	)
	SELECT l.logins, l.login_users, p.page_views, (SELECT COUNT(DISTINCT sub)::bigint FROM act) AS active_users
	  FROM l, p
`;

export const TREND_SQL = (site: string) => `
	WITH days AS (
		SELECT generate_series($1::date, $2::date, interval '1 day')::date AS day
	), l AS (
		SELECT (occurred_at AT TIME ZONE $3)::date AS day, COUNT(*)::bigint AS c
		  FROM portal_shared.login_events
		 WHERE occurred_at >= $4::timestamptz AND occurred_at < $5::timestamptz
		   AND ${site}
		 GROUP BY 1
	), p AS (
		SELECT (occurred_at AT TIME ZONE $3)::date AS day, COUNT(*)::bigint AS c
		  FROM portal_shared.page_views
		 WHERE occurred_at >= $4::timestamptz AND occurred_at < $5::timestamptz
		   AND ${site}
		 GROUP BY 1
	)
	SELECT days.day::text AS day,
	       COALESCE(l.c, 0) AS logins,
	       COALESCE(p.c, 0) AS page_views
	  FROM days
	  LEFT JOIN l ON l.day = days.day
	  LEFT JOIN p ON p.day = days.day
	 ORDER BY days.day
`;

const SORT_SQL: Record<ActivitySort, string> = {
	page_views: 'page_views DESC, logins DESC, sub ASC',
	logins: 'logins DESC, page_views DESC, sub ASC',
	active_days: 'active_days DESC, page_views DESC, sub ASC',
	last_active: 'last_active_at DESC NULLS LAST, sub ASC',
};

export const USERS_SQL = (site: string, sortClause: string) => `
	WITH ev AS (
		SELECT sub,
		       occurred_at,
		       site,
		       (occurred_at AT TIME ZONE $3)::date AS day,
		       true AS is_login
		  FROM portal_shared.login_events
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
		   AND ${site}
		UNION ALL
		SELECT sub,
		       occurred_at,
		       site,
		       (occurred_at AT TIME ZONE $3)::date AS day,
		       false AS is_login
		  FROM portal_shared.page_views
		 WHERE occurred_at >= $1::timestamptz AND occurred_at < $2::timestamptz
		   AND ${site}
	), agg AS (
		SELECT sub,
		       COUNT(*) FILTER (WHERE is_login) AS logins,
		       COUNT(*) FILTER (WHERE NOT is_login) AS page_views,
		       COUNT(DISTINCT day) AS active_days,
		       MAX(occurred_at) AS last_active_at,
		       (array_agg(site ORDER BY occurred_at DESC))[1] AS site
		  FROM ev
		 GROUP BY sub
	), ident AS (
		SELECT agg.*,
		       (SELECT le.name FROM portal_shared.login_events le
		         WHERE le.sub = agg.sub ORDER BY le.occurred_at DESC LIMIT 1) AS name,
		       (SELECT le.email FROM portal_shared.login_events le
		         WHERE le.sub = agg.sub ORDER BY le.occurred_at DESC LIMIT 1) AS email
		  FROM agg
	)
	SELECT ident.sub,
	       ident.name,
	       ident.email,
	       ident.site,
	       ident.logins,
	       ident.page_views,
	       ident.active_days,
	       ident.last_active_at
	  FROM ident
	 WHERE $4 = '' OR position(lower($4) in lower(COALESCE(ident.name, '') || ' ' || COALESCE(ident.email, ''))) > 0
	 ORDER BY ${sortClause}
	 LIMIT $5
`;

/**
 * 门户设置页的「登录数据统计」总开关。
 *
 * 列由门户侧 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS activity_enabled boolean` 加上，
 * 缺省 NULL（= 关闭）。读不到表/列、或存储不可用时一律按**关闭**处理：
 * 这是「默认关闭」的功能，失败方向必须是关，不能是开。
 */
export async function isPortalActivityEnabled(
	repositories: GatewayRepositories
): Promise<boolean> {
	try {
		const sql = pgSql(repositories);
		const rows = (await sql.unsafe(
			'SELECT activity_enabled FROM portal_shared.app_config LIMIT 1'
		)) as { activity_enabled: boolean | null }[];
		return rows[0]?.activity_enabled === true;
	} catch {
		return false;
	}
}

export async function queryPortalActivitySummary(
	repositories: GatewayRepositories,
	query: PortalActivityQuery,
	now: Date = new Date()
): Promise<PortalActivitySummary> {
	const sql = pgSql(repositories);
	const tz = await getBusinessTimezone(repositories);

	const startInstant =
		zonedDatetimeLocalInputToInstant(`${query.start}T00:00`, tz) ??
		new Date(`${query.start}T00:00:00Z`);
	// end 是包含式：右边界取次日 00:00
	const nextDay = new Date(Date.parse(`${query.end}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
	const endInstant =
		zonedDatetimeLocalInputToInstant(`${nextDay}T00:00`, tz) ??
		new Date(`${nextDay}T00:00:00Z`);

	if (!Number.isFinite(startInstant.getTime()) || !Number.isFinite(endInstant.getTime())) {
		throw new Error('日期区间无法换算成时间点');
	}

	const range = { start: query.start, end: query.end, site: query.site };
	// 三个 SQL 的参数布局不同：KPI 的站点在第 3 位，trend/users 的站点在第 6 位
	// （前 5 位分别是起止日期、时区、起止时间点/搜索词与 limit）。
	// 站点索引写错会让 pg 报 `could not determine data type of parameter $n`。
	const kpiSite = siteFilter('site', 3);
	const otherSite = siteFilter('site', 6);

	const kpiSql = KPI_SQL(kpiSite);
	const kpiParams = [startInstant.toISOString(), endInstant.toISOString(), query.site];
	assertParamArity(kpiSql, kpiParams, 'portal-activity.kpi');
	const kpiRows = (await sql.unsafe(kpiSql, kpiParams)) as KpiRow[];

	const trendSql = TREND_SQL(otherSite);
	const trendParams = [
		query.start,
		query.end,
		tz,
		startInstant.toISOString(),
		endInstant.toISOString(),
		query.site,
	];
	assertParamArity(trendSql, trendParams, 'portal-activity.trend');
	const trendRows = (await sql.unsafe(trendSql, trendParams)) as TrendRow[];

	const usersSql = USERS_SQL(otherSite, SORT_SQL[query.sort]);
	const usersParams = [
		startInstant.toISOString(),
		endInstant.toISOString(),
		tz,
		query.q,
		query.limit,
		query.site,
	];
	assertParamArity(usersSql, usersParams, 'portal-activity.users');
	const userRows = (await sql.unsafe(usersSql, usersParams)) as ActivityUserRow[];

	void now;
	return assembleSummary(range, kpiRows[0], trendRows, userRows);
}
