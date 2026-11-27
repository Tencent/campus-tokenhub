/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户用量看板的数据层（独立模块）。
 *
 * 职责只有两件事：
 * 1. `runPortalUsageBackfill`：把 `api_key_request_logs` 的增量按「用户 × 日 × 模型」累加进
 *    `portal_usage_daily`，用水位表保证重跑/重启不重复计数；
 * 2. `queryPortalUsageSummary`：按用户 + 区间读汇总表，供门户一次取完 KPI / 趋势 / 模型排行。
 *
 * 边界：本模块只读写自己新增的两张表 + 只读明细表；不修改网关既有服务与仓储接口。
 * 仅支持 Postgres（管理台其它部署形态本次不覆盖）。
 */
import type { GatewayRepositories } from '@octafuse/core';
import {
	getBusinessTimezone,
	zonedDatetimeLocalInputToInstant,
} from '@octafuse/core/lib/business-timezone';

/** 看板支持的时间区间（服务端白名单，避免任意大区间） */
export const SUPPORTED_DAYS = [1, 3, 7, 30] as const;
export type SupportedDays = (typeof SUPPORTED_DAYS)[number];

const WATERMARK_NAME = 'portal_usage';
const LOCK_KEY = 'portal_usage_worker';
const DEFAULT_BATCH_MINUTES = 5;
const DEFAULT_MAX_ROWS = 50_000;
const MAX_BATCH_MINUTES = 60;

/** postgres.js 的最小结构类型：避免把 `postgres` 的类型带进 admin 包 */
type PgSql = {
	unsafe: (query: string, parameters?: unknown[]) => Promise<unknown[]>;
	begin: <T>(fn: (tx: PgSql) => Promise<T>) => Promise<T>;
};

function pgSql(repositories: GatewayRepositories): PgSql {
	const client = repositories.client;
	if (client.driver !== 'postgres') {
		throw new Error('portal-usage 仅支持 postgres 存储');
	}
	return client.raw as unknown as PgSql;
}

function envInt(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** 业务时区下的「今天」（YYYY-MM-DD） */
export function todayInTimeZone(tz: string, now: Date = new Date()): string {
	const formatter = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	});
	return formatter.format(now);
}

/** 从某天往前推 n 天（只做日期字符串运算，避免时区二次转换） */
export function shiftDay(day: string, deltaDays: number): string {
	const [year, month, date] = day.split('-').map((part) => Number.parseInt(part, 10));
	const base = Date.UTC(year, month - 1, date);
	const shifted = new Date(base + deltaDays * 86_400_000);
	return shifted.toISOString().slice(0, 10);
}

/** 区间内的完整日期列表（升序），用于把稀疏结果补成连续序列 */
export function dayRange(startDay: string, days: number): string[] {
	const result: string[] = [];
	for (let index = 0; index < days; index += 1) result.push(shiftDay(startDay, index));
	return result;
}

/** 明细过滤条件：空主键会让汇总表插入失败并回滚整轮补算 */
const USABLE_ROW_CONDITION = "user_id IS NOT NULL AND model_id IS NOT NULL AND model_id <> ''";

const COUNT_SQL = `
	SELECT COUNT(*)::bigint AS rows
	FROM api_key_request_logs
	WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
	  AND ${USABLE_ROW_CONDITION}
`;

const AGGREGATE_SQL = `
	INSERT INTO portal_usage_daily (
		user_id, day, model_id, tz,
		requests, success_count, error_count,
		input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
		charged_cost, latency_sum, latency_count, data_until, updated_at
	)
	SELECT
		user_id,
		((created_at AT TIME ZONE $3)::date) AS day,
		model_id,
		$3 AS tz,
		COUNT(*)::bigint,
		COUNT(*) FILTER (WHERE status = 'success')::bigint,
		COUNT(*) FILTER (WHERE status = 'error')::bigint,
		COALESCE(SUM(input_tokens), 0)::bigint,
		COALESCE(SUM(output_tokens), 0)::bigint,
		COALESCE(SUM(cache_read_tokens), 0)::bigint,
		COALESCE(SUM(cache_write_tokens), 0)::bigint,
		COALESCE(SUM(charged_cost), 0)::numeric(18, 6),
		COALESCE(SUM(latency_ms), 0)::bigint,
		COUNT(latency_ms)::bigint,
		$2::timestamptz,
		NOW()
	FROM api_key_request_logs
	WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
	  AND ${USABLE_ROW_CONDITION}
	GROUP BY user_id, 2, model_id
	ON CONFLICT (user_id, day, model_id, tz) DO UPDATE SET
		requests = portal_usage_daily.requests + EXCLUDED.requests,
		success_count = portal_usage_daily.success_count + EXCLUDED.success_count,
		error_count = portal_usage_daily.error_count + EXCLUDED.error_count,
		input_tokens = portal_usage_daily.input_tokens + EXCLUDED.input_tokens,
		output_tokens = portal_usage_daily.output_tokens + EXCLUDED.output_tokens,
		cache_read_tokens = portal_usage_daily.cache_read_tokens + EXCLUDED.cache_read_tokens,
		cache_write_tokens = portal_usage_daily.cache_write_tokens + EXCLUDED.cache_write_tokens,
		charged_cost = portal_usage_daily.charged_cost + EXCLUDED.charged_cost,
		latency_sum = portal_usage_daily.latency_sum + EXCLUDED.latency_sum,
		latency_count = portal_usage_daily.latency_count + EXCLUDED.latency_count,
		data_until = GREATEST(COALESCE(portal_usage_daily.data_until, EXCLUDED.data_until), EXCLUDED.data_until),
		updated_at = NOW()
`;

export type BackfillOutcome = {
	advanced: boolean;
	from: string;
	to: string;
	tz: string;
	/** 本轮实际聚合的明细行数（用于日志与压测断言） */
	scannedRows: number;
};

/**
 * 跑一轮增量补算。
 *
 * - 水位不存在时初始化为 `now() - batchMinutes`，**绝不从历史起点开始**（否则首轮会全表扫描）；
 * - 水位行 `FOR UPDATE` 锁 + 单事务推进，重跑/重启不重复计数；
 * - 单轮扫描行数超过上限时自动收窄时间窗，避免长事务长期持锁。
 */
export async function runPortalUsageBackfill(
	repositories: GatewayRepositories,
	options: { now?: Date; batchMinutes?: number; maxRows?: number } = {}
): Promise<BackfillOutcome> {
	const sql = pgSql(repositories);
	const tz = await getBusinessTimezone(repositories);
	const now = options.now ?? new Date();
	const batchMinutes = clamp(
		options.batchMinutes ?? envInt('PORTAL_USAGE_WORKER_BATCH_MINUTES', DEFAULT_BATCH_MINUTES),
		1,
		MAX_BATCH_MINUTES
	);
	const maxRows = options.maxRows ?? envInt('PORTAL_USAGE_MAX_ROWS', DEFAULT_MAX_ROWS);

	return sql.begin(async (tx) => {
		await tx.unsafe(
			`INSERT INTO portal_usage_watermark (name, last_ts)
			 VALUES ($1, $2::timestamptz - ($3::int * interval '1 minute'))
			 ON CONFLICT (name) DO NOTHING`,
			[WATERMARK_NAME, now.toISOString(), batchMinutes]
		);

		const locked = (await tx.unsafe(
			`SELECT last_ts FROM portal_usage_watermark WHERE name = $1 FOR UPDATE`,
			[WATERMARK_NAME]
		)) as { last_ts: string | Date }[];

		const lastRow = locked[0];
		if (!lastRow) {
			return { advanced: false, from: now.toISOString(), to: now.toISOString(), tz, scannedRows: 0 };
		}

		const fromMs = new Date(lastRow.last_ts).getTime();
		const cappedEndMs = Math.min(now.getTime(), fromMs + batchMinutes * 60_000);
		if (!Number.isFinite(fromMs) || cappedEndMs <= fromMs) {
			return {
				advanced: false,
				from: new Date(fromMs).toISOString(),
				to: new Date(cappedEndMs).toISOString(),
				tz,
				scannedRows: 0,
			};
		}

		// 单批上限：行数过多时把窗口对半收窄，直到可接受或窗口只剩 1 分钟
		let from = fromMs;
		let to = cappedEndMs;
		let scannedRows = 0;
		for (let attempt = 0; attempt < 5; attempt += 1) {
			const counted = (await tx.unsafe(COUNT_SQL, [
				new Date(from).toISOString(),
				new Date(to).toISOString(),
			])) as { rows: string | number }[];
			scannedRows = Number(counted[0]?.rows ?? 0);
			if (scannedRows <= maxRows) break;
			const span = to - from;
			if (span <= 60_000) break;
			to = from + Math.floor(span / 2);
		}

		if (scannedRows > 0) {
			await tx.unsafe(AGGREGATE_SQL, [new Date(from).toISOString(), new Date(to).toISOString(), tz]);
		}

		await tx.unsafe(`UPDATE portal_usage_watermark SET last_ts = $2::timestamptz WHERE name = $1`, [
			WATERMARK_NAME,
			new Date(to).toISOString(),
		]);

		return {
			advanced: true,
			from: new Date(from).toISOString(),
			to: new Date(to).toISOString(),
			tz,
			scannedRows,
		};
	});
}

/** 上一个等长窗口的汇总，用于「较上一周期 ±x%」 */
const PREVIOUS_SQL = `
	SELECT
		COALESCE(SUM(requests), 0)::bigint AS prev_requests,
		COALESCE(SUM(charged_cost), 0)::numeric AS prev_cost,
		COALESCE(SUM(input_tokens), 0)::bigint AS prev_input_tokens,
		COALESCE(SUM(output_tokens), 0)::bigint AS prev_output_tokens,
		COALESCE(SUM(cache_read_tokens), 0)::bigint AS prev_cache_read_tokens
	FROM portal_usage_daily
	WHERE user_id = $1 AND tz = $2 AND day >= $3::date AND day < $4::date
`;

/**
 * 窗口内按业务时区的小时分布（0-23），用于「时段活跃」。
 *
 * 直接扫明细表：汇总表只按天聚合，给不出小时维度。
 */
const HOURLY_SQL = `
	SELECT
		EXTRACT(HOUR FROM created_at AT TIME ZONE $4)::int AS hour,
		COUNT(*)::bigint AS hour_requests
	FROM api_key_request_logs
	WHERE user_id = $1
	  AND created_at >= $2::timestamptz
	  AND created_at < $3::timestamptz
	GROUP BY 1
`;

/** 按模型的每日消耗：趋势卡「模型」筛选用，同表聚合，代价可忽略 */
const SERIES_BY_MODEL_SQL = `
	SELECT
		model_id,
		day::text AS day,
		SUM(requests)::bigint AS requests,
		COALESCE(SUM(charged_cost), 0)::numeric AS cost
	FROM portal_usage_daily
	WHERE user_id = $1 AND tz = $2 AND day >= $3::date
	GROUP BY model_id, day
	ORDER BY model_id, day
`;

/**
 * 按密钥的每日消耗。
 *
 * 汇总表 `portal_usage_daily` 没有 api_key_id 维度，只能回明细表按天分组。
 */
const SERIES_BY_KEY_SQL = `
	SELECT
		api_key_id,
		(created_at AT TIME ZONE $4)::date::text AS day,
		COUNT(*)::bigint AS requests,
		COALESCE(SUM(charged_cost), 0)::numeric AS cost
	FROM api_key_request_logs
	WHERE user_id = $1
	  AND created_at >= $2::timestamptz
	  AND created_at < $3::timestamptz
	  AND api_key_id IS NOT NULL
	GROUP BY api_key_id, 2
	ORDER BY api_key_id, 2
`;

type PreviousRow = {
	prev_requests: string | number;
	prev_cost: string | number;
	prev_input_tokens: string | number;
	prev_output_tokens: string | number;
	prev_cache_read_tokens: string | number;
};

/** 每日一个点：趋势卡按维度筛选时用 */
export type PortalUsagePoint = { day: string; requests: number; cost: number };

export type PortalUsageSummary = {
	user_id: string;
	days: SupportedDays;
	tz: string;
	/** 汇总数据覆盖到的时间上界 */
	data_until: string | null;
	kpis: {
		requests: number;
		tokens: { input: number; output: number; cache_read: number };
		cost: number;
		success_rate: number;
		error_count: number;
		avg_latency_ms: number | null;
	};
	series: { day: string; requests: number; tokens: number; cost: number }[];
	models: { model_id: string; requests: number; tokens: number; cost: number }[];
	/** 上一个等长窗口的汇总；全零表示上一周期没有数据 */
	previous: {
		requests: number;
		cost: number;
		tokens: { input: number; output: number; cache_read: number };
	};
	/** 窗口内 0-23 点的请求数分布，空小时补 0 */
	hourly: { hour: number; requests: number }[];
	/** 按模型的每日序列，供趋势卡按模型筛选 */
	series_by_model: { model_id: string; points: PortalUsagePoint[] }[];
	/** 按密钥的每日序列，供趋势卡按密钥筛选 */
	series_by_key: { key_id: string; points: PortalUsagePoint[] }[];
};

type SeriesRow = {
	day: string;
	requests: string | number;
	input_tokens: string | number;
	output_tokens: string | number;
	cache_read_tokens: string | number;
	cost: string | number;
	success_count: string | number;
	error_count: string | number;
	latency_sum: string | number;
	latency_count: string | number;
	data_until: string | Date | null;
};

type ModelRow = {
	model_id: string;
	requests: string | number;
	input_tokens: string | number;
	output_tokens: string | number;
	cost: string | number;
};

/** 按用户 + 区间读汇总数据；返回稀疏序列，由门户补齐空白天 */
export async function queryPortalUsageSummary(
	repositories: GatewayRepositories,
	userId: string,
	days: SupportedDays,
	now: Date = new Date()
): Promise<PortalUsageSummary> {
	const sql = pgSql(repositories);
	const tz = await getBusinessTimezone(repositories);
	const startDay = shiftDay(todayInTimeZone(tz, now), -(days - 1));
	// 上一个等长窗口：[startDay - days, startDay)
	const prevStartDay = shiftDay(startDay, -days);
	const startInstant =
		zonedDatetimeLocalInputToInstant(`${startDay}T00:00`, tz) ??
		new Date(now.getTime() - days * 86_400_000);

	const rows = (await sql.unsafe(
		`SELECT
			day::text AS day,
			SUM(requests)::bigint AS requests,
			COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
			COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
			COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens,
			COALESCE(SUM(charged_cost), 0)::numeric AS cost,
			COALESCE(SUM(success_count), 0)::bigint AS success_count,
			COALESCE(SUM(error_count), 0)::bigint AS error_count,
			COALESCE(SUM(latency_sum), 0)::bigint AS latency_sum,
			COALESCE(SUM(latency_count), 0)::bigint AS latency_count,
			MAX(data_until) AS data_until
		 FROM portal_usage_daily
		 WHERE user_id = $1 AND tz = $2 AND day >= $3::date
		 GROUP BY day
		 ORDER BY day`,
		[userId, tz, startDay]
	)) as SeriesRow[];

	const models = (await sql.unsafe(
		`SELECT
			model_id,
			SUM(requests)::bigint AS requests,
			COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
			COALESCE(SUM(output_tokens), 0)::bigint AS output_tokens,
			COALESCE(SUM(charged_cost), 0)::numeric AS cost
		 FROM portal_usage_daily
		 WHERE user_id = $1 AND tz = $2 AND day >= $3::date
		 GROUP BY model_id
		 ORDER BY SUM(requests) DESC, model_id ASC
		 LIMIT 20`,
		[userId, tz, startDay]
	)) as ModelRow[];

	let requests = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cost = 0;
	let successCount = 0;
	let errorCount = 0;
	let latencySum = 0;
	let latencyCount = 0;
	let dataUntil: string | null = null;

	const series = rows.map((row) => {
		const rowRequests = Number(row.requests ?? 0);
		const rowInput = Number(row.input_tokens ?? 0);
		const rowOutput = Number(row.output_tokens ?? 0);
		requests += rowRequests;
		inputTokens += rowInput;
		outputTokens += rowOutput;
		cacheReadTokens += Number(row.cache_read_tokens ?? 0);
		cost += Number(row.cost ?? 0);
		successCount += Number(row.success_count ?? 0);
		errorCount += Number(row.error_count ?? 0);
		latencySum += Number(row.latency_sum ?? 0);
		latencyCount += Number(row.latency_count ?? 0);
		if (row.data_until) {
			const current = new Date(row.data_until).toISOString();
			if (!dataUntil || current > dataUntil) dataUntil = current;
		}
		return {
			day: row.day,
			requests: rowRequests,
			tokens: rowInput + rowOutput,
			cost: Number(row.cost ?? 0),
		};
	});

	const previousRows = (await sql.unsafe(PREVIOUS_SQL, [
		userId,
		tz,
		prevStartDay,
		startDay,
	])) as PreviousRow[];
	const hourlyRows = (await sql.unsafe(HOURLY_SQL, [
		userId,
		startInstant.toISOString(),
		now.toISOString(),
		tz,
	])) as { hour: string | number; hour_requests: string | number }[];

	const modelSeriesRows = (await sql.unsafe(SERIES_BY_MODEL_SQL, [userId, tz, startDay])) as {
		model_id: string;
		day: string;
		requests: string | number;
		cost: string | number;
	}[];
	const keySeriesRows = (await sql.unsafe(SERIES_BY_KEY_SQL, [
		userId,
		startInstant.toISOString(),
		now.toISOString(),
		tz,
	])) as { api_key_id: string; day: string; requests: string | number; cost: string | number }[];

	const previousRow = previousRows[0];
	const hourlyMap = new Map<number, number>();
	for (const row of hourlyRows) {
		const hour = Number(row.hour);
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
		hourlyMap.set(hour, (hourlyMap.get(hour) ?? 0) + Number(row.hour_requests ?? 0));
	}

	const modelSeries = new Map<string, PortalUsagePoint[]>();
	for (const row of modelSeriesRows) {
		if (!row.model_id) continue;
		const points = modelSeries.get(row.model_id) ?? [];
		points.push({ day: row.day, requests: Number(row.requests ?? 0), cost: Number(row.cost ?? 0) });
		modelSeries.set(row.model_id, points);
	}

	const keySeries = new Map<string, PortalUsagePoint[]>();
	for (const row of keySeriesRows) {
		if (!row.api_key_id) continue;
		const points = keySeries.get(row.api_key_id) ?? [];
		points.push({ day: row.day, requests: Number(row.requests ?? 0), cost: Number(row.cost ?? 0) });
		keySeries.set(row.api_key_id, points);
	}

	return {
		user_id: userId,
		days,
		tz,
		data_until: dataUntil,
		kpis: {
			requests,
			tokens: { input: inputTokens, output: outputTokens, cache_read: cacheReadTokens },
			cost,
			success_rate: requests > 0 ? successCount / requests : 0,
			error_count: errorCount,
			avg_latency_ms: latencyCount > 0 ? latencySum / latencyCount : null,
		},
		series,
		models: models.map((row) => ({
			model_id: row.model_id,
			requests: Number(row.requests ?? 0),
			tokens: Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0),
			cost: Number(row.cost ?? 0),
		})),
		previous: {
			requests: Number(previousRow?.prev_requests ?? 0),
			cost: Number(previousRow?.prev_cost ?? 0),
			tokens: {
				input: Number(previousRow?.prev_input_tokens ?? 0),
				output: Number(previousRow?.prev_output_tokens ?? 0),
				cache_read: Number(previousRow?.prev_cache_read_tokens ?? 0),
			},
		},
		hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, requests: hourlyMap.get(hour) ?? 0 })),
		series_by_model: [...modelSeries.entries()].map(([modelId, points]) => ({
			model_id: modelId,
			points,
		})),
		series_by_key: [...keySeries.entries()].map(([keyId, points]) => ({ key_id: keyId, points })),
	};
}

/** TPM 曲线支持的区间：与门户时间选择器一一对应 */
export const TPM_RANGES = ['24h', '3d', '7d', '30d'] as const;
export type TpmRange = (typeof TPM_RANGES)[number];

/**
 * 区间 → 分桶。分桶数刻意控制在 24~30 个：
 * 每分钟一个点在 30 天窗口下会变成 4 万个点，前端无法渲染；每天一个点又会抹掉峰值。
 * 每个点取「分桶内单分钟 Token 的最大值」，即分段峰值 TPM（不是该分桶的平均速率）。
 *
 * 窗口按业务时区的自然日对齐（与 `/summary`、KPI 取数口径一致），因此
 * `24h` 实际是「今天 0 点到现在」，而不是滚动 24 小时。
 */
const TPM_WINDOWS: Record<TpmRange, { bucketSeconds: number; days: number }> = {
	'24h': { bucketSeconds: 3_600, days: 1 },
	'3d': { bucketSeconds: 3 * 3_600, days: 3 },
	'7d': { bucketSeconds: 6 * 3_600, days: 7 },
	'30d': { bucketSeconds: 86_400, days: 30 },
};

/** 分桶数硬上限：即使时钟异常也不会返回上万点 */
const TPM_MAX_BUCKETS = 200;

/** 图例最多返回的模型数（按峰值降序取前 N 个） */
const TPM_MAX_MODELS = 6;

/**
 * 先按分钟聚合，再按自适应分桶取最大值。
 *
 * `api_key_request_logs.created_at` 是请求开始时间，走
 * `idx_api_key_request_logs_user_created (user_id, created_at)` 只扫该用户窗口内的行。
 */
const TPM_SERIES_SQL = `
	WITH per_minute AS (
		SELECT
			model_id,
			to_timestamp(floor(extract(epoch FROM created_at) / 60) * 60) AS minute_start,
			COALESCE(SUM(total_tokens), 0)::bigint AS tokens
		FROM api_key_request_logs
		WHERE user_id = $1
		  AND created_at >= $2::timestamptz
		  AND created_at < $3::timestamptz
		  AND model_id IS NOT NULL
		  AND model_id <> ''
		GROUP BY 1, 2
	),
	bucketed AS (
		SELECT
			model_id,
			LEAST(
				floor(extract(epoch FROM (minute_start - $2::timestamptz)) / $4::numeric),
				$5::numeric - 1
			)::int AS bucket_index,
			tokens
		FROM per_minute
	)
	SELECT
		b.model_id,
		COALESCE(m.display_name, '') AS model_name,
		b.bucket_index,
		MAX(b.tokens)::bigint AS peak_tpm
	FROM bucketed b
	LEFT JOIN models m ON m.id = b.model_id
	GROUP BY 1, 2, 3
	ORDER BY 4 DESC, 1 ASC
`;

const TPM_STATS_SQL = `
	SELECT
		COUNT(*)::bigint AS requests,
		COALESCE(SUM(total_tokens), 0)::bigint AS tokens,
		COALESCE(SUM(input_tokens), 0)::bigint AS input_tokens,
		COALESCE(SUM(cache_read_tokens), 0)::bigint AS cache_read_tokens
	FROM api_key_request_logs
	WHERE user_id = $1
	  AND created_at >= $2::timestamptz
	  AND created_at < $3::timestamptz
`;

const TPM_CURRENT_SQL = `
	SELECT COALESCE(SUM(total_tokens), 0)::bigint AS tokens
	FROM api_key_request_logs
	WHERE user_id = $1 AND created_at >= now() - interval '60 seconds'
`;

/**
 * 窗口内「每分钟请求数」的峰值，即实测 RPM。
 *
 * 与 TPM 曲线同源同窗口：分分钟按 epoch 取整聚合（与 `TPM_SERIES_SQL` 的
 * `floor(epoch/60)` 完全一致），再取 COUNT 的最大值。
 * 按用户级统计而不是按模型，因为限流是账号维度的。
 */
const TPM_PEAK_RPM_SQL = `
	SELECT COALESCE(MAX(per_minute_count), 0)::bigint AS peak_rpm
	FROM (
		SELECT COUNT(*)::bigint AS per_minute_count
		FROM api_key_request_logs
		WHERE user_id = $1
		  AND created_at >= $2::timestamptz
		  AND created_at < $3::timestamptz
		GROUP BY floor(extract(epoch FROM created_at) / 60)
	) AS per_minute_counts
`;

export type PortalUsageTpmModelSeries = {
	model_id: string;
	model_name: string;
	/** 该模型在窗口内的峰值 TPM（分桶峰值的最大值） */
	peak_tpm: number;
	/** 与 `buckets` 等长；每个元素是该分桶内的峰值 TPM，空桶为 0 */
	points: number[];
};

export type PortalUsageTpmSeries = {
	user_id: string;
	range: TpmRange;
	tz: string;
	from: string;
	to: string;
	bucket_seconds: number;
	/** 各分桶起始时间（UTC ISO，升序），长度 = bucketCount */
	buckets: string[];
	models: PortalUsageTpmModelSeries[];
	/** 全窗口峰值点（跨模型），全零时为 null */
	peak: { model_id: string; bucket_index: number; tpm: number } | null;
	stats: {
		/** 最近 60 秒 Token 合计 */
		current_tpm: number;
		requests: number;
		tokens: number;
		/** 缓存读取 Token / 输入 Token */
		cache_hit_rate: number;
		/** 窗口内每分钟请求数的峰值（实测 RPM，账号级） */
		peak_rpm: number;
	};
};

type TpmSeriesRow = {
	model_id: string;
	model_name: string | null;
	bucket_index: string | number;
	peak_tpm: string | number;
};

type TpmStatsRow = {
	requests: string | number;
	tokens: string | number;
	input_tokens: string | number;
	cache_read_tokens: string | number;
};

/**
 * 按模型 × 自适应分桶查询峰值 TPM，供门户「算力使用汇总」折线图使用。
 *
 * 窗口按业务时区自然日对齐（今天 0 点 / 前 N-1 天 0 点 → 现在），与 `/summary`
 * 的口径一致；分桶内的值取该桶内单分钟 Token 的最大值，因此曲线上的点是
 * 「那一刻的 TPM」而不是桶平均。未走完的最后一个桶同样取已有分钟的最大值。
 */
export async function queryPortalUsageTpmSeries(
	repositories: GatewayRepositories,
	userId: string,
	range: TpmRange,
	now: Date = new Date()
): Promise<PortalUsageTpmSeries> {
	const sql = pgSql(repositories);
	const tz = await getBusinessTimezone(repositories);
	const window = TPM_WINDOWS[range];
	const bucketMs = window.bucketSeconds * 1_000;
	const toMs = now.getTime();
	const startDay = shiftDay(todayInTimeZone(tz, now), -(window.days - 1));
	const startInstant = zonedDatetimeLocalInputToInstant(`${startDay}T00:00`, tz);
	const fromMs = Math.min(startInstant?.getTime() ?? toMs - window.days * 86_400_000, toMs);
	const bucketCount = Math.min(
		TPM_MAX_BUCKETS,
		Math.max(1, Math.ceil((toMs - fromMs) / bucketMs))
	);
	const from = new Date(fromMs).toISOString();
	const to = new Date(toMs).toISOString();
	const buckets = Array.from({ length: bucketCount }, (_, index) =>
		new Date(fromMs + index * bucketMs).toISOString()
	);

	const rows = (await sql.unsafe(TPM_SERIES_SQL, [
		userId,
		from,
		to,
		window.bucketSeconds,
		bucketCount,
	])) as TpmSeriesRow[];
	const statsRows = (await sql.unsafe(TPM_STATS_SQL, [userId, from, to])) as TpmStatsRow[];
	const currentRows = (await sql.unsafe(TPM_CURRENT_SQL, [userId])) as { tokens: string | number }[];
	const rpmRows = (await sql.unsafe(TPM_PEAK_RPM_SQL, [userId, from, to])) as {
		peak_rpm: string | number;
	}[];

	const models = new Map<string, PortalUsageTpmModelSeries>();
	let peak: PortalUsageTpmSeries['peak'] = null;

	for (const row of rows) {
		const modelId = row.model_id;
		if (!modelId) continue;
		let entry = models.get(modelId);
		if (!entry) {
			if (models.size >= TPM_MAX_MODELS) continue;
			const displayName = row.model_name?.trim();
			entry = {
				model_id: modelId,
				model_name: displayName && displayName.length > 0 ? displayName : modelId,
				peak_tpm: 0,
				points: new Array<number>(bucketCount).fill(0),
			};
			models.set(modelId, entry);
		}
		const index = Number(row.bucket_index);
		const value = Number(row.peak_tpm ?? 0);
		const inRange = Number.isInteger(index) && index >= 0 && index < bucketCount;
		if (inRange) {
			entry.points[index] = Math.max(entry.points[index], value);
		}
		if (value > entry.peak_tpm) entry.peak_tpm = value;
		if (inRange && value > (peak?.tpm ?? 0)) {
			peak = { model_id: modelId, bucket_index: index, tpm: value };
		}
	}

	const stats = statsRows[0];
	const inputTokens = Number(stats?.input_tokens ?? 0);
	const cacheReadTokens = Number(stats?.cache_read_tokens ?? 0);

	return {
		user_id: userId,
		range,
		tz,
		from,
		to,
		bucket_seconds: window.bucketSeconds,
		buckets,
		models: [...models.values()],
		peak,
		stats: {
			current_tpm: Number(currentRows[0]?.tokens ?? 0),
			requests: Number(stats?.requests ?? 0),
			tokens: Number(stats?.tokens ?? 0),
			cache_hit_rate:
				inputTokens > 0 ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens)) : 0,
			peak_rpm: Number(rpmRows[0]?.peak_rpm ?? 0),
		},
	};
}

/** 多副本自保护：拿不到锁就跳过本轮，避免两个 worker 抢水位行锁 */
export async function tryPortalUsageLock(repositories: GatewayRepositories): Promise<boolean> {
	const sql = pgSql(repositories);
	const rows = (await sql.unsafe('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
		LOCK_KEY,
	])) as { locked: boolean }[];
	return rows[0]?.locked === true;
}

export async function releasePortalUsageLock(repositories: GatewayRepositories): Promise<void> {
	const sql = pgSql(repositories);
	await sql.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_KEY]);
}
