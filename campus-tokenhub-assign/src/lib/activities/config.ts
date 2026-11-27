/**
 * 算力加油包活动配置（唯一数据源）。
 *
 * 想加/改活动只改这个文件，不用动页面和接口：
 * - `points` 是展示用的「算力值」，到账金额 = points / POINTS_PER_YUAN（默认 100 算力值 = 1 元），
 *   走网关 `POST /api/admin/users/:id/wallet/credit` 加进永久额度，不占每期周期额度。
 * - `period` 决定多久能领一次：`once`（活动期内一次）/`daily`/`weekly`/`monthly`。
 *   防重复靠网关的加额幂等键（`external_ref`），同一个人同一周期重复提交只会入账一次。
 * - `startsOn` / `endsOn` 是活动时间窗（Asia/Shanghai，含首尾），
 *   `weekdays` 用来做「只在周末可领」这类限制（0=周日 … 6=周六）。
 * - `id` 一经上线不要再改：它是幂等键的一部分，改了等于让所有人能再领一次。
 *
 * 例：周末限定活动
 *   { id: 'weekend-recharge', title: '周末加油包', points: 500, period: 'daily',
 *     weekdays: [0, 6], closedHint: '周六、周日可领', summary: [...] }
 */

import type { TokenActivityConfig } from './types';

export const ACTIVITY_CONFIG: TokenActivityConfig[] = [
  {
    id: 'new-model-trial',
    title: '新模型尝鲜',
    points: 2000,
    badge: '限时抢领',
    featured: true,
    period: 'once',
    startsOn: '2026-11-10',
    endsOn: '2026-12-31',
    ctaLabel: '立即领取',
    summary: ['DeepSeek V4.1 Flash 1017 原厂直供', '活动期每人限领一次，到账后叠加到永久额度'],
    enabled: true,
  },
  {
    id: 'daily-recharge',
    title: '每日加油包',
    points: 500,
    period: 'daily',
    ctaLabel: '领取',
    summary: ['每天可申领一次 · 全校师生', '支持全场已上架大模型'],
    enabled: true,
  },
];
