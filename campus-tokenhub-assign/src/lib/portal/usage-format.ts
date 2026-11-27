/**
 * 看板的纯展示计算：数字格式化、进度、趋势图坐标。
 *
 * 单独抽出来的原因：这些函数是所有「看起来对不对」的源头（NaN、除零、单点序列、
 * 全零序列），可以脱离 React 直接测。
 */

export type SeriesPoint = { day: string; requests: number; tokens: number; cost: number };

/** Token 数量：小于千直接显示，千/百万用一位小数 */
export function formatTokens(value: number | null | undefined): string {
	if (!Number.isFinite(value ?? NaN) || value == null) return '—';
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`;
	if (abs >= 1_000) return `${trimZero(value / 1_000)}K`;
	return String(value);
}

function trimZero(value: number): string {
	return (Math.round(value * 10) / 10).toString();
}

/** 0~1 的比例转百分比字符串 */
export function formatPercent(rate: number | null | undefined, digits = 1): string {
	if (rate == null || !Number.isFinite(rate)) return '—';
	const percent = Math.min(100, Math.max(0, rate * 100));
	return `${percent.toFixed(digits)}%`;
}

/** 额度使用率（0~100 的整数），max 为 null 或 0 时返回 0 */
export function budgetPercent(spent: number | null | undefined, max: number | null | undefined): number {
	if (!max || max <= 0 || !Number.isFinite(max)) return 0;
	const used = ((spent ?? 0) / max) * 100;
	if (!Number.isFinite(used)) return 0;
	return Math.min(100, Math.max(0, Math.round(used)));
}

export type LinePoint = { index: number; x: number; y: number; value: number };

/**
 * 折线图坐标：把序列映射到 viewBox 内（留 padding 边距）。
 *
 * - 全零序列：贴底画一条水平线（不产生 NaN，也不因除零跳到顶部）；
 * - 单点序列：画在中间高度，避免退化成 0 长线段；
 * - 空序列：返回空数组，调用方不渲染折线。
 */
export function buildLinePoints(
	series: SeriesPoint[],
	key: 'requests' | 'tokens' | 'cost',
	width: number,
	height: number,
	padding = 4
): LinePoint[] {
	if (series.length === 0) return [];
	const usableWidth = Math.max(1, width - padding * 2);
	const usableHeight = Math.max(1, height - padding * 2);
	const values = series.map((point) => Math.max(0, point[key] ?? 0));
	const max = Math.max(...values);

	if (series.length === 1) {
		const y = max === 0 ? height - padding : padding;
		return [{ index: 0, x: padding, y: round2(y), value: values[0] ?? 0 }];
	}

	return values.map((value, index) => {
		const x = padding + (usableWidth * index) / (series.length - 1);
		const ratio = max === 0 ? 0 : value / max;
		const y = padding + usableHeight * (1 - ratio);
		return { index, x: round2(x), y: round2(y), value };
	});
}

/** 折线的 points 属性（与 buildLinePoints 同一套坐标） */
export function buildPolylinePoints(
	series: SeriesPoint[],
	key: 'requests' | 'tokens' | 'cost',
	width: number,
	height: number,
	padding = 4
): string {
	return buildLinePoints(series, key, width, height, padding)
		.map((point) => `${point.x},${point.y}`)
		.join(' ');
}

/** 面积图的闭合路径（首尾落到基线），空序列返回空串 */
export function buildAreaPath(
	series: SeriesPoint[],
	key: 'requests' | 'tokens' | 'cost',
	width: number,
	height: number,
	padding = 4
): string {
	const points = buildPolylinePoints(series, key, width, height, padding);
	if (!points) return '';
	const baseline = height - padding;
	const first = points.split(' ')[0]?.split(',')[0] ?? String(padding);
	const last = points.split(' ').at(-1)?.split(',')[0] ?? String(width - padding);
	return `M ${first},${baseline} L ${points.replaceAll(' ', ' L ')} L ${last},${baseline} Z`;
}

function round2(value: number): number {
	return Math.round(value * 100) / 100;
}

/**
 * 横轴标签抽稀：最多保留 maxLabels 个（优先首尾与均匀分布），
 * 返回 `{ day, label }`，label 只取 MM-DD。
 */
export function pickAxisLabels(series: SeriesPoint[], maxLabels = 6): { day: string; label: string }[] {
	if (series.length === 0) return [];
	const step = Math.max(1, Math.ceil(series.length / maxLabels));
	const picked = series.filter((_, index) => index % step === 0 || index === series.length - 1);
	return picked.map((point) => ({ day: point.day, label: point.day.slice(5) }));
}

/** 序列中的峰值点（用于图上的高亮点），全零或空序列返回 null */export function peakPoint(
	series: SeriesPoint[],
	key: 'requests' | 'tokens' | 'cost'
): { index: number; value: number } | null {
	if (series.length === 0) return null;
	let bestIndex = 0;
	let best = series[0]?.[key] ?? 0;
	series.forEach((point, index) => {
		const value = point[key] ?? 0;
		if (value > best) {
			best = value;
			bestIndex = index;
		}
	});
	return best > 0 ? { index: bestIndex, value: best } : null;
}

/**
 * 横轴标签抽稀：最多保留 maxLabels 个，首尾必留、中间等距。
 *
 * 与 `pickAxisLabels` 的区别：这里返回下标而不是文案，供「标签绝对定位」的
 * 折线图使用。位置按 `(count-1)/(maxLabels-1)` 等分后取整，避免按整数步长
 * 抽样时最后两段间距突然变窄（标签挤在一起）。
 */
export function pickLabelIndices(count: number, maxLabels = 6): number[] {
	if (count <= 0) return [];
	if (count <= maxLabels) return Array.from({ length: count }, (_, index) => index);
	const step = (count - 1) / (maxLabels - 1);
	const indices: number[] = [];
	for (let index = 0; index < maxLabels; index += 1) indices.push(Math.round(index * step));
	indices[0] = 0;
	indices[maxLabels - 1] = count - 1;
	return [...new Set(indices)];
}
