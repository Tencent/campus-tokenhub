import { describe, expect, it } from 'vitest';
import {
	budgetPercent,
	buildAreaPath,
	buildLinePoints,
	buildPolylinePoints,
	formatPercent,
	formatTokens,
	peakPoint,
	pickAxisLabels,
	pickLabelIndices,
	type SeriesPoint,
} from '@/lib/portal/usage-format';

function point(day: string, requests: number, tokens: number, cost: number): SeriesPoint {
	return { day, requests, tokens, cost };
}

describe('formatTokens', () => {
	it('按千/百万缩写', () => {
		expect(formatTokens(0)).toBe('0');
		expect(formatTokens(999)).toBe('999');
		expect(formatTokens(1500)).toBe('1.5K');
		expect(formatTokens(2_400_000)).toBe('2.4M');
	});

	it('空值与非法值显示占位符', () => {
		expect(formatTokens(null)).toBe('—');
		expect(formatTokens(undefined)).toBe('—');
		expect(formatTokens(Number.NaN)).toBe('—');
	});
});

describe('formatPercent', () => {
	it('0~1 转百分比并夹取边界', () => {
		expect(formatPercent(0.9)).toBe('90.0%');
		expect(formatPercent(1.2)).toBe('100.0%');
		expect(formatPercent(0)).toBe('0.0%');
	});

	it('空值显示占位符', () => {
		expect(formatPercent(null)).toBe('—');
	});
});

describe('budgetPercent', () => {
	it('计算并夹取 0~100', () => {
		expect(budgetPercent(5, 20)).toBe(25);
		expect(budgetPercent(40, 20)).toBe(100);
		expect(budgetPercent(1, 0)).toBe(0);
		expect(budgetPercent(1, null)).toBe(0);
	});
});

describe('buildPolylinePoints', () => {
	it('空序列返回空串', () => {
		expect(buildPolylinePoints([], 'tokens', 100, 40)).toBe('');
	});

	it('全零序列不产生 NaN，贴底', () => {
		const points = buildPolylinePoints(
			[point('2026-11-15', 0, 0, 0), point('2026-11-16', 0, 0, 0)],
			'tokens',
			100,
			40
		);
		expect(points).not.toContain('NaN');
		const ys = points.split(' ').map((pair) => Number(pair.split(',')[1]));
		expect(ys.every((y) => y === 36)).toBe(true);
	});

	it('单点序列落在中间高度且横坐标为首个 padding', () => {
		const points = buildPolylinePoints([point('2026-11-17', 5, 500, 0.1)], 'tokens', 100, 40);
		expect(points).toBe('4,4');
	});

	it('峰值落在顶部 padding 上', () => {
		const points = buildPolylinePoints(
			[point('2026-11-15', 0, 10, 0), point('2026-11-16', 0, 100, 0), point('2026-11-17', 0, 50, 0)],
			'tokens',
			100,
			40
		);
		const pairs = points.split(' ');
		expect(pairs[1]).toBe('50,4');
	});
});

describe('buildLinePoints', () => {
	it('空序列返回空数组', () => {
		expect(buildLinePoints([], 'tokens', 100, 40)).toEqual([]);
	});

	it('返回与 polyline 一致的坐标，并带上原始值', () => {
		const series = [
			point('2026-11-15', 0, 10, 0),
			point('2026-11-16', 0, 100, 0),
			point('2026-11-17', 0, 50, 0),
		];
		const points = buildLinePoints(series, 'tokens', 100, 40);
		expect(points.map((item) => `${item.x},${item.y}`).join(' ')).toBe(
			buildPolylinePoints(series, 'tokens', 100, 40)
		);
		expect(points.map((item) => item.value)).toEqual([10, 100, 50]);
		expect(points.map((item) => item.index)).toEqual([0, 1, 2]);
	});

	it('单点序列落在中间高度', () => {
		expect(buildLinePoints([point('2026-11-17', 5, 500, 0.1)], 'tokens', 100, 40)).toEqual([
			{ index: 0, x: 4, y: 4, value: 500 },
		]);
	});
});

describe('buildAreaPath', () => {
	it('闭合到基线，空序列返回空串', () => {
		expect(buildAreaPath([], 'tokens', 100, 40)).toBe('');
		const path = buildAreaPath(
			[point('2026-11-15', 1, 10, 0), point('2026-11-16', 2, 20, 0)],
			'tokens',
			100,
			40
		);
		expect(path.startsWith('M ')).toBe(true);
		expect(path.endsWith('Z')).toBe(true);
		expect(path).toContain('L 96,36');
	});
});

describe('pickAxisLabels', () => {
	it('空序列返回空数组', () => {
		expect(pickAxisLabels([])).toEqual([]);
	});

	it('30 天抽稀到不超过 6 个且包含末尾', () => {
		const series = Array.from({ length: 30 }, (_, index) =>
			point(`2026-11-${String(index + 1).padStart(2, '0')}`, index, index * 10, 0)
		);
		const labels = pickAxisLabels(series, 6);
		expect(labels.length).toBeLessThanOrEqual(7);
		expect(labels.at(-1)?.day).toBe(series.at(-1)?.day);
		expect(labels[0].label).toBe('11-01');
	});
});

describe('peakPoint', () => {
	it('返回最大值位置，全零返回 null', () => {
		expect(peakPoint([], 'tokens')).toBeNull();
		expect(peakPoint([point('2026-11-15', 0, 0, 0)], 'tokens')).toBeNull();
		expect(
			peakPoint([point('2026-11-15', 1, 10, 0), point('2026-11-16', 3, 30, 0)], 'tokens')
		).toEqual({ index: 1, value: 30 });
	});
});

describe('pickLabelIndices', () => {
	it('点数不超过上限时全量返回', () => {
		expect(pickLabelIndices(0)).toEqual([]);
		expect(pickLabelIndices(1)).toEqual([0]);
		expect(pickLabelIndices(6)).toEqual([0, 1, 2, 3, 4, 5]);
	});

	it('24 个分桶抽稀到 6 个且首尾保留', () => {
		const indices = pickLabelIndices(24, 6);
		expect(indices.length).toBeLessThanOrEqual(6);
		expect(indices[0]).toBe(0);
		expect(indices.at(-1)).toBe(23);
	});

	it('30 个分桶不会被 slice 掉首项', () => {
		const indices = pickLabelIndices(30, 6);
		expect(indices[0]).toBe(0);
		expect(indices.at(-1)).toBe(29);
		expect(indices.length).toBeLessThanOrEqual(6);
	});
});
