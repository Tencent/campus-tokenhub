/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户用量看板数据层的单元测试（不需要数据库：用结构化 fake 替代 postgres.js）。
 *
 * 重点覆盖评审提出的边界：
 * - 水位不存在时初始化为 now() - batchMinutes，首轮绝不扫历史；
 * - 空主键（user_id / model_id 为空）的行被聚合 SQL 过滤；
 * - 单批行数超限时自动收窄窗口；
 * - 非 postgres 驱动直接报错（本模块只支持 PG）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import {
	dayRange,
	queryPortalUsageSummary,
	queryPortalUsageTpmSeries,
	runPortalUsageBackfill,
	shiftDay,
	todayInTimeZone,
	tryPortalUsageLock,
} from './service';

type SqlCall = { query: string; params?: unknown[] };

type FakeSql = {
	unsafe: (query: string, parameters?: unknown[]) => Promise<unknown[]>;
	begin: <T>(fn: (tx: FakeSql) => Promise<T>) => Promise<T>;
};

function createFakeSql(handler: (call: SqlCall) => unknown[]): { sql: FakeSql; calls: SqlCall[] } {
	const calls: SqlCall[] = [];
	const sql: FakeSql = {
		unsafe: async (query, parameters) => {
			const call = { query, params: parameters };
			calls.push(call);
			return handler(call);
		},
		begin: async (fn) => fn(sql),
	};
	return { sql, calls };
}

function createRepositories(sql: FakeSql, driver: 'postgres' | 'sqlite' = 'postgres'): GatewayRepositories {
	return {
		client: { driver, raw: sql },
		systemConfig: { getConfig: async () => 'Asia/Shanghai' },
	} as unknown as GatewayRepositories;
}

/** 按查询语句内容分派的默认 handler */
function defaultHandler(overrides: {
	lastTs: string;
	counts?: number[];
	summaryRows?: unknown[];
	modelRows?: unknown[];
	previousRow?: Record<string, unknown>;
	hourlyRows?: unknown[];
	modelSeriesRows?: unknown[];
	keySeriesRows?: unknown[];
}) {
	let countIndex = 0;
	return (call: SqlCall): unknown[] => {
		const q = call.query;
		if (q.includes('INSERT INTO portal_usage_watermark')) return [];
		if (q.includes('SELECT last_ts')) return [{ last_ts: overrides.lastTs }];
		if (q.includes('SELECT COUNT(*)::bigint AS rows')) {
			const counts = overrides.counts ?? [0];
			const value = counts[Math.min(countIndex, counts.length - 1)];
			countIndex += 1;
			return [{ rows: value }];
		}
		if (q.includes('INSERT INTO portal_usage_daily')) return [];
		if (q.includes('UPDATE portal_usage_watermark')) return [];
		if (q.includes('AS prev_requests')) {
			return [
				overrides.previousRow ?? {
					prev_requests: 0,
					prev_cost: 0,
					prev_input_tokens: 0,
					prev_output_tokens: 0,
					prev_cache_read_tokens: 0,
				},
			];
		}
		if (q.includes('EXTRACT(HOUR FROM')) return overrides.hourlyRows ?? [];
		if (q.includes('GROUP BY model_id, day')) return overrides.modelSeriesRows ?? [];
		if (q.includes('GROUP BY api_key_id')) return overrides.keySeriesRows ?? [];
		if (q.includes('FROM portal_usage_daily') && q.includes('GROUP BY model_id')) {
			return overrides.modelRows ?? [];
		}
		if (q.includes('FROM portal_usage_daily')) return overrides.summaryRows ?? [];
		return [];
	};
}

test('todayInTimeZone 按业务时区切换自然日', () => {
	// 2026-11-17T17:00:00Z = 2026-11-18 01:00 +08
	assert.equal(todayInTimeZone('Asia/Shanghai', new Date('2026-11-17T17:00:00Z')), '2026-11-18');
	assert.equal(todayInTimeZone('Asia/Shanghai', new Date('2026-11-17T15:59:00Z')), '2026-11-17');
	assert.equal(todayInTimeZone('UTC', new Date('2026-11-17T17:00:00Z')), '2026-11-17');
});

test('shiftDay / dayRange 生成连续日期', () => {
	assert.equal(shiftDay('2026-11-01', -6), '2026-10-26');
	assert.equal(shiftDay('2026-12-31', 1), '2027-01-01');
	const range = dayRange('2026-11-11', 7);
	assert.equal(range.length, 7);
	assert.equal(range[0], '2026-11-11');
	assert.equal(range[6], '2026-11-17');
});

test('水位不存在时初始化为 now - batchMinutes，且首轮窗口不超过批次大小', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	// 模拟「初始化后立刻读到 now - 3 分钟」的水位
	const { sql, calls } = createFakeSql(
		defaultHandler({ lastTs: new Date(now.getTime() - 3 * 60_000).toISOString(), counts: [0] })
	);

	const outcome = await runPortalUsageBackfill(createRepositories(sql), { now, batchMinutes: 5 });

	const init = calls.find((call) => call.query.includes('INSERT INTO portal_usage_watermark'));
	assert.ok(init, '必须初始化水位');
	assert.equal(init?.params?.[1], now.toISOString());
	assert.equal(init?.params?.[2], 5);
	assert.equal(outcome.advanced, true);
	assert.equal(outcome.tz, 'Asia/Shanghai');
	// from 取水位（now-3min），to 不超过 now
	assert.equal(outcome.from, new Date(now.getTime() - 3 * 60_000).toISOString());
	assert.equal(outcome.to, now.toISOString());
});

test('窗口内没有明细时只推进水位，不写汇总表', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql, calls } = createFakeSql(
		defaultHandler({ lastTs: new Date(now.getTime() - 60_000).toISOString(), counts: [0] })
	);

	await runPortalUsageBackfill(createRepositories(sql), { now, batchMinutes: 5 });

	assert.equal(
		calls.some((call) => call.query.includes('INSERT INTO portal_usage_daily')),
		false
	);
	const update = calls.find((call) => call.query.includes('UPDATE portal_usage_watermark'));
	assert.equal(update?.params?.[1], now.toISOString());
});

test('聚合 SQL 过滤空主键，避免整轮补算回滚', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql, calls } = createFakeSql(
		defaultHandler({ lastTs: new Date(now.getTime() - 60_000).toISOString(), counts: [12] })
	);

	await runPortalUsageBackfill(createRepositories(sql), { now, batchMinutes: 5 });

	const aggregate = calls.find((call) => call.query.includes('INSERT INTO portal_usage_daily'));
	assert.ok(aggregate, '有数据时必须写汇总表');
	assert.match(aggregate?.query ?? '', /user_id IS NOT NULL/);
	assert.match(aggregate?.query ?? '', /model_id IS NOT NULL/);
	assert.match(aggregate?.query ?? '', /model_id <> ''/);
	assert.match(aggregate?.query ?? '', /ON CONFLICT \(user_id, day, model_id, tz\) DO UPDATE/);
	assert.equal(aggregate?.params?.[2], 'Asia/Shanghai');
});

test('单批行数超过上限时收窄窗口', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const start = now.getTime() - 10 * 60_000;
	const { sql, calls } = createFakeSql(
		defaultHandler({
			lastTs: new Date(start).toISOString(),
			// 第一次 120000 行超限 → 收窄 → 第二次 40000 行
			counts: [120_000, 40_000],
		})
	);

	const outcome = await runPortalUsageBackfill(createRepositories(sql), {
		now,
		batchMinutes: 10,
		maxRows: 50_000,
	});

	assert.equal(outcome.scannedRows, 40_000);
	const update = calls.find((call) => call.query.includes('UPDATE portal_usage_watermark'));
	const advancedTo = new Date(String(update?.params?.[1])).getTime();
	assert.ok(advancedTo < now.getTime(), '收窄后水位不应直接推到 now');
	assert.ok(advancedTo > start, '水位仍要向前推进');
});

test('非 postgres 驱动直接报错', async () => {
	const { sql } = createFakeSql(() => []);
	const repositories = createRepositories(sql, 'sqlite');
	await assert.rejects(() => runPortalUsageBackfill(repositories), /仅支持 postgres/);
});

test('advisory lock 未取得时返回 false', async () => {
	const { sql } = createFakeSql(() => [{ locked: false }]);
	assert.equal(await tryPortalUsageLock(createRepositories(sql)), false);
});

test('摘要接口聚合 KPI、稀疏序列与模型排行', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql } = createFakeSql(
		defaultHandler({
			lastTs: now.toISOString(),
			summaryRows: [
				{
					day: '2026-11-15',
					requests: '2',
					input_tokens: '100',
					output_tokens: '50',
					cache_read_tokens: '10',
					cost: '0.001',
					success_count: '2',
					error_count: '0',
					latency_sum: '200',
					latency_count: '2',
					data_until: '2026-11-17T11:55:00.000Z',
				},
				{
					day: '2026-11-17',
					requests: '8',
					input_tokens: '800',
					output_tokens: '400',
					cache_read_tokens: '0',
					cost: '0.009',
					success_count: '7',
					error_count: '1',
					latency_sum: '400',
					latency_count: null,
					data_until: '2026-11-17T12:00:00.000Z',
				},
			],
			modelRows: [{ model_id: 'm-1', requests: '10', input_tokens: '900', output_tokens: '450', cost: '0.01' }],
			previousRow: {
				prev_requests: '8',
				prev_cost: '0.008',
				prev_input_tokens: '700',
				prev_output_tokens: '300',
				prev_cache_read_tokens: '50',
			},
			hourlyRows: [
				{ hour: 9, hour_requests: '3' },
				{ hour: 20, hour_requests: '7' },
			],
			modelSeriesRows: [
				{ model_id: 'm-1', day: '2026-11-16', requests: '4', cost: '0.004' },
				{ model_id: 'm-1', day: '2026-11-17', requests: '6', cost: '0.006' },
				{ model_id: 'm-2', day: '2026-11-17', requests: '2', cost: '0.002' },
			],
			keySeriesRows: [{ api_key_id: 'k-1', day: '2026-11-17', requests: '10', cost: '0.01' }],
		})
	);

	const summary = await queryPortalUsageSummary(createRepositories(sql), '11111111-1111-4111-8111-111111111111', 7, now);

	assert.equal(summary.kpis.requests, 10);
	assert.equal(summary.kpis.tokens.input, 900);
	assert.equal(summary.kpis.tokens.output, 450);
	assert.equal(summary.kpis.success_rate, 0.9);
	assert.equal(summary.kpis.error_count, 1);
	// latency_count 合计 2（第二行 null 视为 0），均值 600/2
	assert.equal(summary.kpis.avg_latency_ms, 300);
	assert.equal(summary.series.length, 2);
	assert.equal(summary.series[1].tokens, 1200);
	assert.equal(summary.data_until, '2026-11-17T12:00:00.000Z');
	assert.equal(summary.models[0].model_id, 'm-1');
	assert.equal(summary.models[0].tokens, 1350);
	assert.equal(summary.tz, 'Asia/Shanghai');
	// 上一周期环比：窗口为 [startDay-7, startDay)
	assert.equal(summary.previous.requests, 8);
	assert.equal(summary.previous.cost, 0.008);
	assert.equal(summary.previous.tokens.cache_read, 50);
	// 时段分布补齐 24 个小时，空小时为 0
	assert.equal(summary.hourly.length, 24);
	assert.equal(summary.hourly[9].requests, 3);
	assert.equal(summary.hourly[20].requests, 7);
	assert.equal(summary.hourly[0].requests, 0);
	// 按模型 / 按密钥的每日序列（趋势卡筛选用）
	assert.equal(summary.series_by_model.length, 2);
	assert.deepEqual(summary.series_by_model[0], {
		model_id: 'm-1',
		points: [
			{ day: '2026-11-16', requests: 4, cost: 0.004 },
			{ day: '2026-11-17', requests: 6, cost: 0.006 },
		],
	});
	assert.deepEqual(summary.series_by_key, [
		{ key_id: 'k-1', points: [{ day: '2026-11-17', requests: 10, cost: 0.01 }] },
	]);
});

test('无数据时返回零值且不产生 NaN', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql } = createFakeSql(defaultHandler({ lastTs: now.toISOString(), summaryRows: [], modelRows: [] }));

	const summary = await queryPortalUsageSummary(createRepositories(sql), '11111111-1111-4111-8111-111111111111', 30, now);

	assert.equal(summary.kpis.requests, 0);
	assert.equal(summary.kpis.success_rate, 0);
	assert.equal(summary.kpis.avg_latency_ms, null);
	assert.deepEqual(summary.series, []);
	assert.deepEqual(summary.models, []);
});

/** TPM 曲线的 fake handler：四条查询按语句特征分派 */
function tpmHandler(input: {
	seriesRows?: unknown[];
	statsRow?: Record<string, unknown>;
	currentRow?: Record<string, unknown>;
	peakRpmRow?: Record<string, unknown>;
}): (call: SqlCall) => unknown[] {
	return (call) => {
		if (call.query.includes('WITH per_minute')) return input.seriesRows ?? [];
		if (call.query.includes('AS peak_rpm')) return [input.peakRpmRow ?? { peak_rpm: 0 }];
		if (call.query.includes('COUNT(*)::bigint AS requests')) {
			return [input.statsRow ?? { requests: 0, tokens: 0, input_tokens: 0, cache_read_tokens: 0 }];
		}
		if (call.query.includes("interval '60 seconds'")) {
			return [input.currentRow ?? { tokens: 0 }];
		}
		return [];
	};
}

test('TPM 曲线：24 小时按业务日对齐、按小时分桶，取桶内单分钟峰值', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql, calls } = createFakeSql(
		tpmHandler({
			seriesRows: [
				{ model_id: 'm-1', model_name: 'DeepSeek V4.1 Flash', bucket_index: 19, peak_tpm: '27850000' },
				{ model_id: 'm-1', model_name: 'DeepSeek V4.1 Flash', bucket_index: 16, peak_tpm: '9000000' },
				{ model_id: 'm-2', model_name: '', bucket_index: 19, peak_tpm: '1200000' },
			],
			statsRow: { requests: '12', tokens: '3000000', input_tokens: '1000', cache_read_tokens: '100' },
			currentRow: { tokens: '4720000' },
			peakRpmRow: { peak_rpm: '18' },
		})
	);

	const series = await queryPortalUsageTpmSeries(
		createRepositories(sql),
		'11111111-1111-4111-8111-111111111111',
		'24h',
		now
	);

	assert.equal(series.bucket_seconds, 3600);
	// Asia/Shanghai 当天 0 点 = 2026-11-16T16:00Z，到 now 共 20 个整点桶
	assert.equal(series.buckets.length, 20);
	assert.equal(series.buckets[0], '2026-11-16T16:00:00.000Z');
	assert.equal(series.buckets.at(-1), '2026-11-17T11:00:00.000Z');
	assert.equal(series.from, '2026-11-16T16:00:00.000Z');
	assert.equal(series.to, '2026-11-17T12:00:00.000Z');

	assert.equal(series.models.length, 2);
	const primary = series.models[0];
	assert.equal(primary.model_name, 'DeepSeek V4.1 Flash');
	assert.equal(primary.points.length, 20);
	assert.equal(primary.points[19], 27_850_000);
	assert.equal(primary.points[16], 9_000_000);
	assert.equal(primary.points[0], 0);
	// 没有 display_name 时回退到 model_id
	assert.equal(series.models[1].model_name, 'm-2');

	assert.deepEqual(series.peak, { model_id: 'm-1', bucket_index: 19, tpm: 27_850_000 });
	assert.deepEqual(series.stats, {
		current_tpm: 4_720_000,
		requests: 12,
		tokens: 3_000_000,
		cache_hit_rate: 0.1,
		peak_rpm: 18,
	});

	// 四条查询都带上了用户与窗口边界（最近 60 秒那条按设计只带用户）
	assert.ok(calls.every((call) => call.params?.[0] === '11111111-1111-4111-8111-111111111111'));
	const rpmCall = calls.find((call) => call.query.includes('AS peak_rpm'));
	assert.ok(rpmCall, '必须查询每分钟请求峰值');
	assert.equal(rpmCall.params?.[1], '2026-11-16T16:00:00.000Z');
	assert.equal(rpmCall.params?.[2], '2026-11-17T12:00:00.000Z');
});

test('TPM 曲线：30 天按天分桶，空数据返回零值且 peak 为 null', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const { sql } = createFakeSql(tpmHandler({ seriesRows: [] }));

	const series = await queryPortalUsageTpmSeries(
		createRepositories(sql),
		'11111111-1111-4111-8111-111111111111',
		'30d',
		now
	);

	assert.equal(series.bucket_seconds, 86_400);
	assert.equal(series.buckets.length, 30);
	assert.deepEqual(series.models, []);
	assert.equal(series.peak, null);
	assert.equal(series.stats.current_tpm, 0);
	assert.equal(series.stats.cache_hit_rate, 0);
});

test('TPM 曲线：模型数超过 6 个时按峰值截断', async () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const seriesRows = Array.from({ length: 8 }, (_, index) => ({
		model_id: `m-${index}`,
		model_name: `model-${index}`,
		bucket_index: 0,
		peak_tpm: String(10_000_000 - index * 1_000_000),
	}));
	const { sql } = createFakeSql(tpmHandler({ seriesRows }));

	const series = await queryPortalUsageTpmSeries(
		createRepositories(sql),
		'11111111-1111-4111-8111-111111111111',
		'24h',
		now
	);

	assert.equal(series.models.length, 6);
	assert.deepEqual(
		series.models.map((model) => model.model_id),
		['m-0', 'm-1', 'm-2', 'm-3', 'm-4', 'm-5']
	);
});
