/**
 * 活动规则（纯函数，不碰网络）：算力值换算、活动时间窗、领取周期键、卡片状态。
 *
 * 业务时区固定 Asia/Shanghai：学生看到的「今天」必须和活动文案一致，
 * 不能跟着服务器时区走（容器里通常是 UTC，晚上 8 点后日期就错一天）。
 */

import { parseGatewayTime } from '@/lib/gateway/format';
import { businessTimeZone } from '@/lib/portal/business-time';
import type { ActivityState, ClaimPeriod, TokenActivityConfig } from './types';

/** 业务时区：与价格窗口 / 看板切日共用同一个来源（见 `lib/portal/business-time.ts`） */
export const ACTIVITY_TIME_ZONE = businessTimeZone();

/** 算力值换算比例：100 算力值 = 1 元永久额度 */
export const POINTS_PER_YUAN = 100;

/** 加额幂等键前缀，用来在网关审计流水里认出「门户活动领取」 */
export const CLAIM_REF_PREFIX = 'portal-activity';

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: ACTIVITY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 业务时区下的今天，YYYY-MM-DD */
export function businessDay(now: number): string {
  return dayFormatter.format(new Date(now));
}

/** 把 YYYY-MM-DD 解析成 UTC 零点，只用于日期加减/取星期，不受时区影响 */
function toUtcDate(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 0=周日 … 6=周六；入参格式不合法时返回 -1 */
export function dayOfWeek(day: string): number {
  const date = toUtcDate(day);
  return date ? date.getUTCDay() : -1;
}

export function shiftDay(day: string, deltaDays: number): string {
  const date = toUtcDate(day);
  if (!date) return day;
  return new Date(date.getTime() + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

/** 当周周一的日期（周日算上一周的最后一天），用作「每周一次」的周期键 */
function mondayOf(day: string): string {
  const weekday = dayOfWeek(day);
  if (weekday < 0) return day;
  return shiftDay(day, weekday === 0 ? -6 : 1 - weekday);
}

/**
 * 一个领取周期对应的时间段键。
 *
 * 同一周期内多次提交会算出同一个键，配合网关的加额幂等（`UNIQUE(user_id, dedup_key)`），
 * 并发点两次也只会入账一次。
 */
export function claimPeriodKey(period: ClaimPeriod, now: number): string {
  const day = businessDay(now);
  switch (period) {
    case 'once':
      return 'once';
    case 'daily':
      return day;
    case 'weekly':
      return `w${mondayOf(day)}`;
    case 'monthly':
      return day.slice(0, 7);
  }
}

/** 网关加额时用的 external_ref，同时是「这个人这个周期领过没」的判定依据 */
export function claimExternalRef(activityId: string, userId: string, period: ClaimPeriod, now: number): string {
  return `${CLAIM_REF_PREFIX}/${activityId}/${encodeURIComponent(userId)}/${claimPeriodKey(period, now)}`;
}

/** 从 external_ref 认出活动 ID；不是门户活动发放的返回 null */
export function parseClaimRef(ref: string): { activityId: string } | null {
  if (!ref.startsWith(`${CLAIM_REF_PREFIX}/`)) return null;
  const parts = ref.split('/');
  if (parts.length < 4) return null;
  const activityId = parts[1]?.trim();
  return activityId ? { activityId } : null;
}

/** 算力值 → 到账金额（元），保留两位小数 */
export function pointsToYuan(points: number): number {
  if (!Number.isFinite(points)) return 0;
  return Math.round((points / POINTS_PER_YUAN) * 100) / 100;
}

export function formatPoints(points: number): string {
  if (!Number.isFinite(points)) return '0';
  return points.toLocaleString('zh-CN');
}

/**
 * 活动时间窗文案：「10月20日 – 10月31日」；只有一端时退化成「10月20日 起」这类说法。
 *
 * 学生端卡片与管理员配置页的预览共用，避免两处各写一遍导致文案不一致。
 */
export function activityWindowLabel(
  startsOn: string | undefined,
  endsOn: string | undefined
): string | null {
  const short = (day: string): string => {
    const [, month, date] = day.split('-');
    return `${Number(month)}月${Number(date)}日`;
  };
  if (startsOn && endsOn) return `${short(startsOn)} – ${short(endsOn)}`;
  if (startsOn) return `${short(startsOn)} 起`;
  if (endsOn) return `截至 ${short(endsOn)}`;
  return null;
}

/**
 * 当前状态。顺序不能改：
 * 先判时间窗（未开始 / 已结束都不该再看星期与领取记录），再判星期，最后看本周期的领取记录。
 */
export function resolveActivityState(
  activity: TokenActivityConfig,
  claimedRefs: ReadonlySet<string>,
  userId: string,
  now: number
): ActivityState {
  const day = businessDay(now);
  if (activity.startsOn && day < activity.startsOn) return 'not-started';
  if (activity.endsOn && day > activity.endsOn) return 'ended';
  if (activity.weekdays && activity.weekdays.length > 0 && !activity.weekdays.includes(dayOfWeek(day))) {
    return 'closed';
  }
  return claimedRefs.has(claimExternalRef(activity.id, userId, activity.period, now)) ? 'claimed' : 'claimable';
}

const CLAIMED_BUTTON_LABEL: Record<ClaimPeriod, string> = {
  once: '已领取',
  daily: '今日已领',
  weekly: '本周已领',
  monthly: '本月已领',
};

export function activityButtonLabel(activity: TokenActivityConfig, state: ActivityState): string {
  switch (state) {
    case 'claimable':
      return activity.ctaLabel ?? '立即领取';
    case 'claimed':
      return CLAIMED_BUTTON_LABEL[activity.period];
    case 'not-started':
      return '未开始';
    case 'ended':
      return '已结束';
    case 'closed':
      return '暂不可领';
  }
}

/** 按钮下方的说明；可领时为 null，不占位置 */
export function activityStatusLabel(activity: TokenActivityConfig, state: ActivityState): string | null {
  switch (state) {
    case 'claimable':
      return null;
    case 'claimed':
      return activity.period === 'once' ? '已叠加到永久额度' : '下个周期可再领';
    case 'not-started':
      return activity.startsOn ? `${activity.startsOn} 开始` : '活动还未开始';
    case 'ended':
      return '活动已结束';
    case 'closed':
      return activity.closedHint ?? '今日不可领取';
  }
}

/** 近一年时间窗（领取汇总只统计这段时间） */
export function withinLastYear(claimedAt: string | null, now: number): boolean {
  if (!claimedAt) return true;
  const at = parseGatewayTime(claimedAt);
  if (!at) return true;
  return now - at.getTime() <= YEAR_MS;
}
