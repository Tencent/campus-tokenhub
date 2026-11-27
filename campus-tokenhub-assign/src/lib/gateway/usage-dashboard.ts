import { getGatewayClient, type GatewayClient } from './client';
import { getUser } from './users';
import { getUserLogs, listKeys } from './keys';
import type { GatewayKey, GatewayRequestLog, GatewayUser } from './types';

/** 看板区间：与网关 `/admin/portal-usage/summary` 的白名单一致 */
export type UsageRange = '24h' | '3d' | '7d' | '30d';

/** 看板区间 → 汇总表天数（`24h` 取业务时区当天，分钟级吞吐见 tpm-series） */
const RANGE_DAYS: Record<UsageRange, number> = { '24h': 1, '3d': 3, '7d': 7, '30d': 30 };
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;
/** 明细固定 10 条：单行含 request_body，20 条实测可达 50KB~400KB */
const RECENT_LIMIT = 10;
/** 请求体再截一次：网关已按 16KB 截断，看板只展示「输入参数」摘要 */
const REQUEST_BODY_MAX_CHARS = 2000;

/**
 * 「对话明细」的单行。
 *
 * 网关日志有 59 列（raw_usage / pricing_audit 等），这里只挑页面要用的字段，
 * 避免整行透传到客户端把 RSC 载荷放大。
 */
export type UsageCallLog = {
	id: string;
	createdAt: string | null;
	modelId: string | null;
	status: string | null;
	requestProtocol: string | null;
	requestOperation: string | null;
	routeGroup: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	reasoningTokens: number | null;
	totalTokens: number | null;
	cost: string | null;
	latencyMs: number | null;
	firstTokenMs: number | null;
	streamDurationMs: number | null;
	errorMessage: string | null;
	/** 脱敏请求体（无消息正文），已按展示上限截断 */
	requestBody: string | null;
};

export type PortalUsageSummary = {
	user_id: string;
	days: number;
	tz: string;
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
	/** 上一个等长窗口的汇总，用于环比 */
	previous: {
		requests: number;
		cost: number;
		tokens: { input: number; output: number; cache_read: number };
	};
	/** 窗口内 0-23 点的请求数分布 */
	hourly: { hour: number; requests: number }[];
	/** 按模型拆分的每日序列，趋势卡按模型筛选用 */
	series_by_model: { model_id: string; points: { day: string; requests: number; cost: number }[] }[];
	/** 按密钥拆分的每日序列，趋势卡按密钥筛选用 */
	series_by_key: { key_id: string; points: { day: string; requests: number; cost: number }[] }[];
};

export type UsageDashboard = {
	userId: string;
	range: UsageRange;
	days: number;
	tz: string | null;
	/** 汇总数据覆盖到的时间上界 */
	dataUntil: string | null;
	budget: {
		spent: number;
		max: number | null;
		resetAt: string | null;
		period: string | null;
	} | null;
	kpis: PortalUsageSummary['kpis'] | null;
	series: { day: string; requests: number; tokens: number; cost: number }[];
	models: PortalUsageSummary['models'];
	/** 上一周期汇总；网关不可用时为空值 */
	previous: PortalUsageSummary['previous'];
	/** 0-23 点请求分布；网关不可用时为空数组 */
	hourly: PortalUsageSummary['hourly'];
	/** 按模型的每日序列 */
	seriesByModel: PortalUsageSummary['series_by_model'];
	/** 按密钥的每日序列 */
	seriesByKey: PortalUsageSummary['series_by_key'];
	keys: { id: string; name: string; status: string; lastUsedAt: string | null }[];
	recent: UsageCallLog[];
	/** 各区块是否降级（true = 该区块取数失败，页面显示占位） */
	degraded: { budget: boolean; summary: boolean; keys: boolean; recent: boolean };
};

export type UsageDashboardDeps = {
	summary?: (userId: string, days: number) => Promise<PortalUsageSummary>;
	user?: (userId: string) => Promise<GatewayUser>;
	keys?: (userId: string) => Promise<GatewayKey[]>;
	logs?: (userId: string, limit: number) => Promise<GatewayRequestLog[]>;
	now?: () => number;
	/** 测试用：跳过缓存 */
	skipCache?: boolean;
};

type CacheEntry = { expiresAt: number; value: UsageDashboard };

const cache = new Map<string, CacheEntry>();

/** 测试用：清空进程内缓存 */
export function clearUsageDashboardCache(): void {
	cache.clear();
}

function readCache(key: string, now: number): UsageDashboard | null {
	const hit = cache.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= now) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

function writeCache(key: string, value: UsageDashboard, now: number): void {
	if (cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
}

/** 业务时区下的今天（YYYY-MM-DD） */
function todayInTimeZone(tz: string, nowMs: number): string {
	return new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(new Date(nowMs));
}

function shiftDay(day: string, deltaDays: number): string {
	const [year, month, date] = day.split('-').map((part) => Number.parseInt(part, 10));
	return new Date(Date.UTC(year, month - 1, date) + deltaDays * 86_400_000).toISOString().slice(0, 10);
}

/**
 * 把网关返回的稀疏序列补齐成连续日期。
 *
 * 汇总表只在有调用的日期有行，趋势图需要连续的 x 轴；缺失日期补 0。
 */
export function loadSeries(
	summary: PortalUsageSummary | null,
	days: number,
	tz: string,
	nowMs: number
): { day: string; requests: number; tokens: number; cost: number }[] {
	const startDay = shiftDay(todayInTimeZone(tz, nowMs), -(days - 1));
	const byDay = new Map(summary?.series.map((item) => [item.day, item]) ?? []);
	const result: { day: string; requests: number; tokens: number; cost: number }[] = [];
	for (let index = 0; index < days; index += 1) {
		const day = shiftDay(startDay, index);
		const hit = byDay.get(day);
		result.push({
			day,
			requests: hit?.requests ?? 0,
			tokens: hit?.tokens ?? 0,
			cost: hit?.cost ?? 0,
		});
	}
	return result;
}

/**
 * 日志行 → 看板明细行。
 *
 * `request_body` 在网关侧已脱敏（无消息正文），这里再按展示上限截断，
 * 避免单行参数把 RSC 载荷顶到几十 KB。
 */
export function toUsageCallLog(raw: GatewayRequestLog): UsageCallLog {
	const requestBody = raw.request_body?.trim() ? raw.request_body : null;
	return {
		id: raw.id,
		createdAt: raw.created_at ?? null,
		modelId: raw.model_id ?? null,
		status: raw.status ?? null,
		requestProtocol: raw.request_protocol ?? null,
		requestOperation: raw.request_operation ?? null,
		routeGroup: raw.route_group ?? null,
		inputTokens: raw.input_tokens ?? null,
		outputTokens: raw.output_tokens ?? null,
		cacheReadTokens: raw.cache_read_tokens ?? null,
		cacheWriteTokens: raw.cache_write_tokens ?? null,
		reasoningTokens: raw.reasoning_tokens ?? null,
		totalTokens: raw.total_tokens ?? null,
		cost: raw.charged_cost ?? null,
		latencyMs: raw.latency_ms ?? null,
		firstTokenMs: raw.first_token_ms ?? null,
		streamDurationMs: raw.stream_duration_ms ?? null,
		errorMessage: raw.error_message ?? null,
		requestBody:
			requestBody && requestBody.length > REQUEST_BODY_MAX_CHARS
				? `${requestBody.slice(0, REQUEST_BODY_MAX_CHARS)}…(已截断)`
				: requestBody,
	};
}

/** 一段任意天数的用量：首屏「今日 / 本月」这类窗口用，不套看板的固定区间。 */
export type UsageWindow = {
	days: number;
	kpis: PortalUsageSummary['kpis'] | null;
	series: { day: string; requests: number; tokens: number; cost: number }[];
	dataUntil: string | null;
	/** true = 取数失败，调用方按空数据渲染 */
	degraded: boolean;
};

/** 网关 `/portal-usage/summary` 只接受这几个天数，其余一律 400 */
export const USAGE_WINDOW_DAYS = [1, 3, 7, 30] as const;

/** 把任意天数收敛到网关支持的窗口，避免调用方传 18 天直接 400 */
function normalizeDays(days: number): number {
	return USAGE_WINDOW_DAYS.reduce((best, candidate) =>
		Math.abs(candidate - days) < Math.abs(best - days) ? candidate : best
	);
}

/**
 * 任意天数窗口的用量汇总。
 *
 * `days` 会先收敛到 1/3/7/30。需要「本月」这类窗口时传 30，
 * 再按 `series[].day` 过滤出当月，别指望网关直接给自然月。
 * 失败不抛，统一降级成空窗口——首屏不该因为一个统计接口 500。
 */
export async function getUsageSummary(
	userId: string,
	days: number,
	deps: Pick<UsageDashboardDeps, 'summary' | 'now'> = {}
): Promise<UsageWindow> {
	const nowMs = deps.now?.() ?? Date.now();
	const windowDays = normalizeDays(days);
	const summaryFn =
		deps.summary ?? ((id: string, dayCount: number) => fetchSummary(id, dayCount, getGatewayClient()));

	try {
		const summary = await summaryFn(userId, windowDays);
		return {
			days: windowDays,
			kpis: summary.kpis ?? null,
			// tz 缺失说明响应不完整，趋势线只能留空
			series: summary.tz ? loadSeries(summary, windowDays, summary.tz, nowMs) : [],
			dataUntil: summary.data_until ?? null,
			degraded: false,
		};
	} catch {
		return { days: windowDays, kpis: null, series: [], dataUntil: null, degraded: true };
	}
}

async function fetchSummary(
	userId: string,
	days: number,
	client: GatewayClient
): Promise<PortalUsageSummary> {
	const response = await client.admin<{ success?: boolean; data?: PortalUsageSummary }>(
		'/api/admin/portal-usage/summary',
		{ query: { user_id: userId, days } }
	);
	const data = response?.data;
	if (!data || typeof data.tz !== 'string') throw new Error('网关未返回用量汇总');
	return data;
}

/**
 * 看板数据入口：一次组装 KPI / 趋势 / 模型排行 / 密钥 / 明细。
 *
 * 四个子请求互不依赖，用 allSettled 隔离失败：任一失败只把对应区块标记为降级，
 * 不让整页 500（学生看到部分数据比看到错误页有用）。
 */
export async function getUsageDashboard(
	userId: string,
	range: UsageRange,
	deps: UsageDashboardDeps = {}
): Promise<UsageDashboard> {
	const days = RANGE_DAYS[range];
	const nowMs = deps.now?.() ?? Date.now();
	const cacheKey = `${userId}|${range}`;
	if (!deps.skipCache) {
		const cached = readCache(cacheKey, nowMs);
		if (cached) return cached;
	}

	// 网关客户端按需构造：注入 deps 的测试不需要真实配置
	const summaryFn =
		deps.summary ?? ((id: string, dayCount: number) => fetchSummary(id, dayCount, getGatewayClient()));
	const userFn = deps.user ?? ((id: string) => getUser(id, getGatewayClient()));
	const keysFn = deps.keys ?? ((id: string) => listKeys(id, getGatewayClient()));
	const logsFn = deps.logs ?? ((id: string, limit: number) => getUserLogs(id, limit, getGatewayClient()));

	const [summaryResult, userResult, keysResult, logsResult] = await Promise.allSettled([
		summaryFn(userId, days),
		userFn(userId),
		keysFn(userId),
		logsFn(userId, RECENT_LIMIT),
	]);

	const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null;
	const user = userResult.status === 'fulfilled' ? userResult.value : null;
	const keys = keysResult.status === 'fulfilled' ? keysResult.value : [];
	const logs = logsResult.status === 'fulfilled' ? logsResult.value : [];
	const tz = summary?.tz ?? null;

	const value: UsageDashboard = {
		userId,
		range,
		days,
		tz,
		dataUntil: summary?.data_until ?? null,
		budget: user
			? {
					spent: user.budget_spent ?? 0,
					max: user.budget_max ?? null,
					resetAt: user.budget_reset_at ?? null,
					period: user.budget_period ?? null,
				}
			: null,
		kpis: summary?.kpis ?? null,
		series: tz ? loadSeries(summary, days, tz, nowMs) : [],
		models: summary?.models ?? [],
		previous: summary?.previous ?? {
			requests: 0,
			cost: 0,
			tokens: { input: 0, output: 0, cache_read: 0 },
		},
		hourly: summary?.hourly ?? [],
		seriesByModel: summary?.series_by_model ?? [],
		seriesByKey: summary?.series_by_key ?? [],
		keys: keys.map((key) => ({
			id: key.id,
			name: key.name ?? key.id,
			status: key.status,
			lastUsedAt: key.last_used_at ?? null,
		})),
		recent: logs.slice(0, RECENT_LIMIT).map(toUsageCallLog),
		degraded: {
			budget: userResult.status === 'rejected',
			summary: summaryResult.status === 'rejected',
			keys: keysResult.status === 'rejected',
			recent: logsResult.status === 'rejected',
		},
	};

	if (!deps.skipCache) writeCache(cacheKey, value, nowMs);
	return value;
}
