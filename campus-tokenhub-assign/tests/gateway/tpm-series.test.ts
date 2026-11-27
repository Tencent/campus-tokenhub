import { beforeEach, describe, expect, it } from 'vitest';
import {
	buildTpmChartData,
	clearTpmSeriesCache,
	formatBucketLabel,
	getTpmSeries,
	type GatewayTpmSeries,
	type TpmRange,
} from '@/lib/gateway/tpm-series';

const NOW = Date.parse('2026-11-17T12:00:00Z');

function rawFixture(overrides: Partial<GatewayTpmSeries> = {}): GatewayTpmSeries {
	return {
		user_id: 'u-1',
		range: '24h',
		tz: 'Asia/Shanghai',
		from: '2026-11-16T12:00:00.000Z',
		to: '2026-11-17T12:00:00.000Z',
		bucket_seconds: 3600,
		buckets: [
			'2026-11-16T12:00:00.000Z',
			'2026-11-16T13:00:00.000Z',
			'2026-11-17T11:00:00.000Z',
		],
		models: [
			{ model_id: 'm-1', model_name: 'DeepSeek V4.1 Flash', peak_tpm: 27_850_000, points: [0, 9_000_000, 27_850_000] },
			{ model_id: 'm-2', model_name: '', peak_tpm: 1_200_000, points: [0, 0, 1_200_000] },
		],
		peak: { model_id: 'm-1', bucket_index: 2, tpm: 27_850_000 },
		stats: { current_tpm: 4_720_000, requests: 12, tokens: 3_000_000, cache_hit_rate: 0.968, peak_rpm: 18 },
		...overrides,
	};
}

describe('formatBucketLabel', () => {
	it('按业务时区输出，24h 看时刻', () => {
		expect(formatBucketLabel('2026-11-17T04:00:00.000Z', 'Asia/Shanghai', '24h')).toBe('12:00');
		expect(formatBucketLabel('2026-11-16T16:00:00.000Z', 'Asia/Shanghai', '24h')).toBe('00:00');
	});

	it('3d/7d 带「日 + 时」，30d 只保留日期', () => {
		expect(formatBucketLabel('2026-11-17T04:00:00.000Z', 'Asia/Shanghai', '3d')).toBe('11-17 12时');
		expect(formatBucketLabel('2026-11-17T04:00:00.000Z', 'Asia/Shanghai', '7d')).toBe('11-17 12时');
		expect(formatBucketLabel('2026-11-17T04:00:00.000Z', 'UTC', '30d')).toBe('11-17');
	});

	it('非法时间返回空串', () => {
		expect(formatBucketLabel('not-a-date', 'Asia/Shanghai', '24h')).toBe('');
	});
});

describe('buildTpmChartData', () => {
	it('生成与分桶等长的标签和点位', () => {
		const data = buildTpmChartData(rawFixture());

		expect(data.labels).toEqual(['20:00', '21:00', '19:00']);
		expect(data.models).toHaveLength(2);
		expect(data.models[0].points).toEqual([0, 9_000_000, 27_850_000]);
		expect(data.models[0].peakTpm).toBe(27_850_000);
		expect(data.peak).toEqual({ modelId: 'm-1', index: 2, tpm: 27_850_000 });
		expect(data.stats.current_tpm).toBe(4_720_000);
	});

	it('display_name 为空时回退到 model_id', () => {
		const data = buildTpmChartData(rawFixture());
		expect(data.models[1].name).toBe('m-2');
	});

	it('点位数量与分桶不一致时补零 / 截断，不产生 NaN', () => {
		const data = buildTpmChartData(
			rawFixture({
				models: [
					{ model_id: 'm-1', model_name: 'm', peak_tpm: 5, points: [5] },
					{ model_id: 'm-2', model_name: 'm2', peak_tpm: 9, points: [1, 2, 3, 4, 5] },
				],
			})
		);

		expect(data.models[0].points).toEqual([5, 0, 0]);
		expect(data.models[1].points).toEqual([1, 2, 3]);
	});

	it('峰值为 0 时返回 null', () => {
		const data = buildTpmChartData(
			rawFixture({ peak: { model_id: 'm-1', bucket_index: 0, tpm: 0 } })
		);
		expect(data.peak).toBeNull();
	});
});

describe('getTpmSeries', () => {
	beforeEach(() => clearTpmSeriesCache());

	it('成功时返回图表数据并写入缓存', async () => {
		let calls = 0;
		const deps = {
			now: () => NOW,
			fetch: async (_userId: string, range: TpmRange) => {
				calls += 1;
				return rawFixture({ range });
			},
		};

		const first = await getTpmSeries('u-1', '24h', deps);
		const second = await getTpmSeries('u-1', '24h', deps);

		expect(first?.range).toBe('24h');
		expect(second).toBe(first);
		expect(calls).toBe(1);
	});

	it('不同区间不共用缓存', async () => {
		let calls = 0;
		const deps = {
			now: () => NOW,
			fetch: async (_userId: string, range: TpmRange) => {
				calls += 1;
				return rawFixture({ range });
			},
		};

		await getTpmSeries('u-1', '24h', deps);
		await getTpmSeries('u-1', '7d', deps);

		expect(calls).toBe(2);
	});

	it('网关失败时返回 null 而不是抛错', async () => {
		const data = await getTpmSeries('u-1', '24h', {
			now: () => NOW,
			fetch: async () => {
				throw new Error('boom');
			},
		});
		expect(data).toBeNull();
	});
});
