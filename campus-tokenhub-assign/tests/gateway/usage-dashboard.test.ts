import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	clearUsageDashboardCache,
	getUsageDashboard,
	loadSeries,
	toUsageCallLog,
	type PortalUsageSummary,
} from '@/lib/gateway/usage-dashboard';
import type { GatewayKey, GatewayRequestLog, GatewayUser } from '@/lib/gateway/types';

const NOW = Date.parse('2026-11-17T12:00:00Z');

function summaryFixture(overrides: Partial<PortalUsageSummary> = {}): PortalUsageSummary {
	return {
		user_id: 'u-1',
		days: 7,
		tz: 'Asia/Shanghai',
		data_until: '2026-11-17T11:55:00.000Z',
		kpis: {
			requests: 10,
			tokens: { input: 900, output: 450, cache_read: 30 },
			cost: 0.01,
			success_rate: 0.9,
			error_count: 1,
			avg_latency_ms: 2100,
		},
		series: [{ day: '2026-11-17', requests: 10, tokens: 1350, cost: 0.01 }],
		models: [{ model_id: 'm-1', requests: 10, tokens: 1350, cost: 0.01 }],
		previous: { requests: 8, cost: 0.008, tokens: { input: 700, output: 300, cache_read: 20 } },
		hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, requests: hour === 20 ? 7 : 0 })),
		series_by_model: [
			{ model_id: 'm-1', points: [{ day: '2026-11-17', requests: 10, cost: 0.01 }] },
		],
		series_by_key: [
			{ key_id: 'k-1', points: [{ day: '2026-11-17', requests: 10, cost: 0.01 }] },
		],
		...overrides,
	};
}

function userFixture(): GatewayUser {
	return {
		id: 'u-1',
		email: 'a@school.local',
		budget_max: 20,
		budget_base: 20,
		budget_spent: 0.5,
		budget_period: 'monthly',
		budget_reset_at: '2026-12-17 14:32:38.054+00',
		wallet_granted: 0,
		wallet_spent: 0,
		status: 'active',
		external_system: 'campus-tokenhub',
		external_user_id: 'school:1',
		active_keys_count: 1,
		created_at: null,
	};
}

function logsFixture(count: number): GatewayRequestLog[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `log-${index}`,
		model_id: 'm-1',
		route_group: 'default',
		input_tokens: 10,
		output_tokens: 20,
		total_tokens: 30,
		charged_cost: '0.0001',
		status: 'success',
		latency_ms: 900,
		error_message: null,
		created_at: '2026-11-17 11:00:00.000+00',
	}));
}

function keysFixture(): GatewayKey[] {
	return [
		{ id: 'k-1', key: 'sk-1', name: '我的密钥', status: 'active', last_used_at: '2026-11-17 10:00:00+00', created_at: null },
	];
}

describe('getUsageDashboard', () => {
	beforeEach(() => clearUsageDashboardCache());

	it('组装 KPI、趋势、模型排行、密钥与明细', async () => {
		const dashboard = await getUsageDashboard('u-1', '7d', {
			now: () => NOW,
			summary: async () => summaryFixture(),
			user: async () => userFixture(),
			keys: async () => keysFixture(),
			logs: async () => logsFixture(3),
		});

		expect(dashboard.days).toBe(7);
		expect(dashboard.tz).toBe('Asia/Shanghai');
		expect(dashboard.kpis?.requests).toBe(10);
		expect(dashboard.budget).toMatchObject({ spent: 0.5, max: 20 });
		expect(dashboard.models).toHaveLength(1);
		expect(dashboard.keys[0]).toMatchObject({ id: 'k-1', name: '我的密钥' });
		expect(dashboard.recent).toHaveLength(3);
		// 7 天区间补零后固定 7 个点
		expect(dashboard.series).toHaveLength(7);
		expect(dashboard.degraded).toEqual({ budget: false, summary: false, keys: false, recent: false });
	});

	it('区间映射：30d → 30，7d → 7', async () => {
		const deps = {
			now: () => NOW,
			summary: async (_id: string, days: number) => summaryFixture({ days }),
			user: async () => userFixture(),
			keys: async () => [],
			logs: async () => [],
		};
		expect((await getUsageDashboard('u-1', '30d', deps)).days).toBe(30);
		clearUsageDashboardCache();
		expect((await getUsageDashboard('u-1', '7d', deps)).days).toBe(7);
	});

	it('汇总失败时降级，其余区块仍返回', async () => {
		const dashboard = await getUsageDashboard('u-1', '7d', {
			now: () => NOW,
			summary: async () => {
				throw new Error('gateway down');
			},
			user: async () => userFixture(),
			keys: async () => keysFixture(),
			logs: async () => logsFixture(2),
		});

		expect(dashboard.degraded.summary).toBe(true);
		expect(dashboard.kpis).toBeNull();
		expect(dashboard.series).toEqual([]);
		expect(dashboard.budget).not.toBeNull();
		expect(dashboard.recent).toHaveLength(2);
	});

	it('明细最多保留 10 条', async () => {
		const dashboard = await getUsageDashboard('u-1', '7d', {
			now: () => NOW,
			summary: async () => summaryFixture(),
			user: async () => userFixture(),
			keys: async () => keysFixture(),
			logs: async () => logsFixture(30),
		});
		expect(dashboard.recent).toHaveLength(10);
	});

	it('60 秒内命中缓存，不重复请求网关', async () => {
		const summary = vi.fn(async () => summaryFixture());
		const deps = {
			now: () => NOW,
			summary,
			user: async () => userFixture(),
			keys: async () => keysFixture(),
			logs: async () => logsFixture(1),
		};

		await getUsageDashboard('u-1', '7d', deps);
		await getUsageDashboard('u-1', '7d', deps);
		expect(summary).toHaveBeenCalledTimes(1);

		// 过期后重新请求
		await getUsageDashboard('u-1', '7d', { ...deps, now: () => NOW + 61_000 });
		expect(summary).toHaveBeenCalledTimes(2);
	});

	it('skipCache 时绕过缓存', async () => {
		const summary = vi.fn(async () => summaryFixture());
		const deps = {
			now: () => NOW,
			summary,
			user: async () => userFixture(),
			keys: async () => [],
			logs: async () => [],
			skipCache: true,
		};
		await getUsageDashboard('u-1', '7d', deps);
		await getUsageDashboard('u-1', '7d', deps);
		expect(summary).toHaveBeenCalledTimes(2);
	});
});

describe('toUsageCallLog', () => {
	it('只保留看板要用的字段，并带出输入/输出明细', () => {
		const row = toUsageCallLog({
			...logsFixture(1)[0],
			request_protocol: 'openai',
			request_operation: 'chat',
			cache_read_tokens: 6,
			cache_write_tokens: 2,
			reasoning_tokens: 4,
			first_token_ms: 320,
			stream_duration_ms: 1200,
			request_body: '{"model":"m-1"}',
		});

		expect(row).toMatchObject({
			id: 'log-0',
			modelId: 'm-1',
			status: 'success',
			requestProtocol: 'openai',
			requestOperation: 'chat',
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 6,
			cacheWriteTokens: 2,
			reasoningTokens: 4,
			totalTokens: 30,
			cost: '0.0001',
			latencyMs: 900,
			firstTokenMs: 320,
			streamDurationMs: 1200,
			errorMessage: null,
			requestBody: '{"model":"m-1"}',
		});
		// 网关原行里的 59 列不跟着透传
		expect(row).not.toHaveProperty('user_email');
	});

	it('超长请求体按展示上限截断，空串归为 null', () => {
		const long = toUsageCallLog({ ...logsFixture(1)[0], request_body: 'x'.repeat(5000) });
		expect(long.requestBody).toHaveLength(2000 + '…(已截断)'.length);
		expect(long.requestBody?.endsWith('…(已截断)')).toBe(true);

		const empty = toUsageCallLog({ ...logsFixture(1)[0], request_body: '   ' });
		expect(empty.requestBody).toBeNull();
	});
});

describe('loadSeries', () => {
	it('把稀疏数据补成连续日期', () => {
		const series = loadSeries(
			summaryFixture({
				series: [{ day: '2026-11-17', requests: 4, tokens: 400, cost: 0.004 }],
			}),
			7,
			'Asia/Shanghai',
			NOW
		);
		expect(series).toHaveLength(7);
		expect(series.at(-1)).toEqual({ day: '2026-11-17', requests: 4, tokens: 400, cost: 0.004 });
		expect(series[0]).toEqual({ day: '2026-11-11', requests: 0, tokens: 0, cost: 0 });
	});

	it('summary 为空时返回全零序列', () => {
		const series = loadSeries(null, 7, 'Asia/Shanghai', NOW);
		expect(series).toHaveLength(7);
		expect(series.every((point) => point.requests === 0 && point.tokens === 0)).toBe(true);
	});
});
