/**
 * 算力值（积分）展示口径。
 *
 * 网关只认金额（元），「算力值」纯粹是门户的展示单位，
 * 换算比例沿用活动规则里那一个常量：100 算力值 = 1 元。
 * 千万不要在这里另立一个比例，否则额度卡与活动卡会算出两个数。
 */

import { POINTS_PER_YUAN } from '@/lib/activities/rules';

export { POINTS_PER_YUAN };

/** 金额（元）→ 算力值（整数）。非法值按 0 处理，避免 NaN 落到页面上。 */
export function toPoints(yuan: number | null | undefined): number {
  if (typeof yuan !== 'number' || !Number.isFinite(yuan)) return 0;
  return Math.round(yuan * POINTS_PER_YUAN);
}

/** 金额（元）→「2,000」（不带单位） */
export function formatPointsFromYuan(yuan: number | null | undefined): string {
  return toPoints(yuan).toLocaleString('zh-CN');
}

/** 金额（元）→「2,000 算力值」 */
export function formatPointsWithUnit(yuan: number | null | undefined): string {
  return `${formatPointsFromYuan(yuan)} 算力值`;
}

/**
 * 单价类金额 → 算力值，最多保留 2 位小数。
 *
 * 与 `formatPointsFromYuan` 的区别：单价常常很小（如 ¥0.008/百万 tokens = 0.8 算力值），
 * 取整会直接变成 0，所以这里不取整。
 */
export function formatPointsPrice(yuan: number | null | undefined): string {
  if (typeof yuan !== 'number' || !Number.isFinite(yuan)) return '—';
  if (yuan === 0) return '0';
  const points = Math.round(yuan * POINTS_PER_YUAN * 100) / 100;
  return points.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

/**
 * 单价（元）→「0.8 算力值/M」。
 *
 * 无价时只返回破折号，不拼单位，避免出现「— 算力值/M」。
 */
export function formatPointsUnitPrice(yuan: number | null | undefined, unit: string): string {
  if (typeof yuan !== 'number' || !Number.isFinite(yuan)) return '—';
  return `${formatPointsPrice(yuan)} 算力值/${unit}`;
}
