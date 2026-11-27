/**
 * 「算力使用汇总」的数据层：按模型 × 自适应分桶的峰值 TPM。
 *
 * 数据来自网关明细表（`api_key_request_logs`），由
 * `GET /admin/portal-usage/tpm-series` 按分钟聚合后再按分桶取最大值。
 * 这里只做「拉取 + 业务时区标签 + 60 秒缓存」，不参与任何分桶计算。
 */

import { getGatewayClient, type GatewayClient } from './client';

export type TpmRange = '24h' | '3d' | '7d' | '30d';

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 500;

/** 网关返回的原始结构（字段与 `portal-usage/service.ts` 一一对应） */
export type GatewayTpmSeries = {
	user_id: string;
	range: TpmRange;
	tz: string;
	from: string;
	to: string;
	bucket_seconds: number;
	buckets: string[];
	models: {
		model_id: string;
		model_name: string;
		peak_tpm: number;
		points: number[];
	}[];
	peak: { model_id: string; bucket_index: number; tpm: number } | null;
	stats: {
		current_tpm: number;
		requests: number;
		tokens: number;
		cache_hit_rate: number;
		/** 窗口内每分钟请求数的峰值（账号级实测 RPM） */
		peak_rpm: number;
	};
};

export type TpmChartModel = {
	id: string;
	name: string;
	/** 该模型在窗口内的峰值 TPM */
	peakTpm: number;
	/** 与 `labels` 等长 */
	points: number[];
};

export type TpmChartData = {
	range: TpmRange;
	bucketSeconds: number;
	/** 按业务时区预格式化的横轴标签 */
	labels: string[];
	models: TpmChartModel[];
	peak: { modelId: string; index: number; tpm: number } | null;
	stats: GatewayTpmSeries['stats'];
	tz: string;
};

/** 横轴标签形态：24h 看时刻，3d/7d 看「日 + 时」，30d 只看日期 */
const LABEL_KIND: Record<TpmRange, 'time' | 'day-hour' | 'day'> = {
	'24h': 'time',
	'3d': 'day-hour',
	'7d': 'day-hour',
	'30d': 'day',
};

function zonedParts(iso: string, tz: string) {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: tz,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(iso));
	const pick = (type: Intl.DateTimeFormatPartTypes) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return {
		year: pick('year'),
		month: pick('month'),
		day: pick('day'),
		hour: pick('hour'),
		minute: pick('minute'),
	};
}

/**
 * 分桶起始时间 → 横轴标签。
 *
 * 时间戳是 UTC，展示必须按业务时区换算；用 `Intl` 而不是手算偏移，
 * 这样换时区配置（含夏令时）也不需要改代码。
 */
export function formatBucketLabel(iso: string, tz: string, range: TpmRange): string {
	const parsed = new Date(iso);
	if (Number.isNaN(parsed.getTime())) return '';
	const { month, day, hour, minute } = zonedParts(iso, tz);
	const kind = LABEL_KIND[range];
	if (kind === 'time') return `${hour}:${minute}`;
	if (kind === 'day-hour') return `${month}-${day} ${hour}时`;
	return `${month}-${day}`;
}

/**
 * 网关响应 → 图表数据。
 *
 * 对长度不一致的脏数据做防御：`points` 截断/补零到 `buckets.length`，
 * 避免折线越界或整条曲线错位。
 */
export function buildTpmChartData(raw: GatewayTpmSeries): TpmChartData {
	const labels = raw.buckets.map((bucket) => formatBucketLabel(bucket, raw.tz, raw.range));
	const models: TpmChartModel[] = raw.models.map((model) => {
		const points = raw.buckets.map((_, index) => {
			const value = model.points[index];
			return Number.isFinite(value) && value > 0 ? value : 0;
		});
		return {
			id: model.model_id,
			name: model.model_name?.trim() || model.model_id,
			peakTpm: Number.isFinite(model.peak_tpm) ? model.peak_tpm : 0,
			points,
		};
	});

	const peak =
		raw.peak && raw.peak.tpm > 0
			? { modelId: raw.peak.model_id, index: raw.peak.bucket_index, tpm: raw.peak.tpm }
			: null;

	return {
		range: raw.range,
		bucketSeconds: raw.bucket_seconds,
		labels,
		models,
		peak,
		stats: raw.stats,
		tz: raw.tz,
	};
}

type CacheEntry = { expiresAt: number; value: TpmChartData };

const cache = new Map<string, CacheEntry>();

/** 测试用：清空进程内缓存 */
export function clearTpmSeriesCache(): void {
	cache.clear();
}

function readCache(key: string, now: number): TpmChartData | null {
	const hit = cache.get(key);
	if (!hit) return null;
	if (hit.expiresAt <= now) {
		cache.delete(key);
		return null;
	}
	return hit.value;
}

function writeCache(key: string, value: TpmChartData, now: number): void {
	if (cache.size >= CACHE_MAX_ENTRIES) {
		const oldest = cache.keys().next();
		if (!oldest.done) cache.delete(oldest.value);
	}
	cache.set(key, { expiresAt: now + CACHE_TTL_MS, value });
}

export type TpmSeriesDeps = {
	fetch?: (userId: string, range: TpmRange) => Promise<GatewayTpmSeries>;
	now?: () => number;
	/** 测试用：跳过缓存 */
	skipCache?: boolean;
};

async function fetchTpmSeries(
	userId: string,
	range: TpmRange,
	client: GatewayClient
): Promise<GatewayTpmSeries> {
	const response = await client.admin<{ success?: boolean; data?: GatewayTpmSeries }>(
		'/api/admin/portal-usage/tpm-series',
		{ query: { user_id: userId, range } }
	);
	const data = response?.data;
	if (!data || !Array.isArray(data.buckets)) throw new Error('网关未返回 TPM 序列');
	return data;
}

/**
 * 读 TPM 折线数据。
 *
 * 失败返回 `null` 而不是抛错：看板是「部分可用」页面，
 * TPM 折线挂了不应该整页 500（与 summary 的降级策略一致）。
 */
export async function getTpmSeries(
	userId: string,
	range: TpmRange,
	deps: TpmSeriesDeps = {}
): Promise<TpmChartData | null> {
	const nowMs = deps.now?.() ?? Date.now();
	const cacheKey = `${userId}|${range}`;
	if (!deps.skipCache) {
		const cached = readCache(cacheKey, nowMs);
		if (cached) return cached;
	}

	const load = deps.fetch ?? ((id: string, r: TpmRange) => fetchTpmSeries(id, r, getGatewayClient()));
	try {
		const raw = await load(userId, range);
		const value = buildTpmChartData(raw);
		if (!deps.skipCache) writeCache(cacheKey, value, nowMs);
		return value;
	} catch (error) {
		console.warn('[portal] TPM 序列读取失败', error instanceof Error ? error.message : error);
		return null;
	}
}
