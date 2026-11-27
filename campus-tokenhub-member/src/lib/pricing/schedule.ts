/**
 * 模型目录里的「官方时段价」计算。
 *
 * 网关的 `pricing_profile.schedule` 是一组窗口 `{start, end, factor, days?}`，
 * 命中窗口就把 factor 乘到该档全部单价上；未命中按 1。
 * 时区取全站业务时区（`lib/portal/business-time.ts`，默认东八区），不跟随运行环境。
 *
 * 注意：catalog 的 `input_price` / `output_price` 是兼容字段（取最低档且不含时段），
 * 展示价必须走这里算。
 */

import { businessTimeZone } from '@/lib/portal/business-time';

export type ScheduleWindow = {
  start: string;
  end: string;
  factor: number;
  /** ISO 星期，1=周一 … 7=周日；缺省表示每天 */
  days?: number[];
  label?: string | null;
};

export type PricingTier = {
  upto?: number | null;
  input_price?: number | null;
  output_price?: number | null;
  cache_read_price?: number | null;
  cache_write_price?: number | null;
};

export type PricingProfile = {
  tiers?: PricingTier[];
  schedule?: ScheduleWindow[] | null;
  image?: { default?: number | null } | null;
  image_billing_mode?: string | null;
};

export type ResolvedPrice = {
  /** 命中窗口的倍率；无 schedule 或未命中为 1 */
  factor: number;
  /** 人类可读的时段标签，例如「空闲时段」「高峰时段」；无时段概念时为 null */
  label: string | null;
  /** 命中的窗口，便于调试与在页面上展示具体区间 */
  window: ScheduleWindow | null;
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  /** 图片按张计价时的单价 */
  imagePrice: number | null;
};

function toMinutes(value: string): number {
  const [h, m] = value.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return Number.NaN;
  return h * 60 + m;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

/** 东八区的「当日第几分钟」与 ISO 星期（1=周一）。 */
export function shanghaiParts(at: Date): { minutes: number; isoWeekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: businessTimeZone(),
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);

  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(pick('hour')) % 24;
  const minute = Number(pick('minute'));
  const isoWeekday = WEEKDAY_INDEX[pick('weekday')] ?? 1;
  return { minutes: hour * 60 + minute, isoWeekday };
}

function matchesWindow(win: ScheduleWindow, minutes: number, isoWeekday: number): boolean {
  const start = toMinutes(win.start);
  const end = toMinutes(win.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;

  const days = win.days && win.days.length > 0 ? win.days : [1, 2, 3, 4, 5, 6, 7];
  const isCrossMidnight = start > end;
  const prevWeekday = isoWeekday === 1 ? 7 : isoWeekday - 1;

  if (!isCrossMidnight) {
    return days.includes(isoWeekday) && minutes >= start && minutes < end;
  }

  // 跨午夜：days 锚定窗口开始日
  if (days.includes(isoWeekday) && minutes >= start) return true;
  return days.includes(prevWeekday) && minutes < end;
}

/** 取命中窗口；都不命中返回 null。 */
export function matchScheduleWindow(
  schedule: ScheduleWindow[] | null | undefined,
  at: Date
): ScheduleWindow | null {
  if (!schedule || schedule.length === 0) return null;
  const { minutes, isoWeekday } = shanghaiParts(at);
  for (const win of schedule) {
    if (matchesWindow(win, minutes, isoWeekday)) return win;
  }
  return null;
}

function pickTier(tiers: PricingTier[] | undefined): PricingTier {
  if (!tiers || tiers.length === 0) return {};
  return tiers[0];
}

function scale(value: number | null | undefined, factor: number): number | null {
  if (value === null || value === undefined) return null;
  return Number((value * factor).toFixed(6));
}

/**
 * 算出「此刻」的价格。
 *
 * - `pricing_profile.schedule` 为空 → factor 1、label null（模型没有时段概念）
 * - 非空但当前未命中任何窗口 → factor 1、label 取「高峰时段」的语义由调用方决定，
 *   这里统一返回 null，让页面自己决定要不要写「其他时段」
 */
export function resolveCurrentPrice(
  profile: PricingProfile | null | undefined,
  at: Date = new Date()
): ResolvedPrice {
  const tier = pickTier(profile?.tiers);
  const hasSchedule = Boolean(profile?.schedule && profile.schedule.length > 0);
  const win = hasSchedule ? matchScheduleWindow(profile?.schedule, at) : null;
  const factor = win ? win.factor : 1;

  return {
    factor,
    label: win ? (win.label ?? describeFactor(win.factor)) : null,
    window: win,
    inputPrice: scale(tier.input_price, factor),
    outputPrice: scale(tier.output_price, factor),
    cacheReadPrice: scale(tier.cache_read_price, factor),
    imagePrice: scale(profile?.image?.default ?? null, factor),
  };
}

/** 倍率 → 中文标签。上游现在约定 0.5 为空闲时段，1 为高峰。 */
export function describeFactor(factor: number): string {
  if (factor < 1) return '空闲时段';
  if (factor > 1) return '高峰时段';
  return '标准时段';
}

/** 给页面用的时段说明文案。 */
export function scheduleHint(profile: PricingProfile | null | undefined, at: Date): string | null {
  if (!profile?.schedule || profile.schedule.length === 0) return null;
  const price = resolveCurrentPrice(profile, at);
  const discount = price.factor === 1 ? '' : ` ×${price.factor}`;
  return `当前${price.label ?? '其他时段'}${discount}；高峰为工作日 9:00–12:00、14:00–18:00（北京时间）`;
}
