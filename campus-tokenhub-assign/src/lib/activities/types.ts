/**
 * 算力加油包（领 token 活动）的类型。
 *
 * 只描述「配置长什么样」与「页面上怎么显示」，网关交互在 claims.ts，
 * 时间窗/频次判定在 rules.ts（纯函数，可单测）。
 */

/** 领取频次：活动期内一次性 / 每天 / 每周 / 每月各一次 */
export type ClaimPeriod = 'once' | 'daily' | 'weekly' | 'monthly';

export type TokenActivityConfig = {
  /** 稳定 ID，写进加额幂等键；上线后不要改，改了等于放开重复领取 */
  id: string;
  title: string;
  /** 算力值；1 元 = POINTS_PER_YUAN 算力值，到账金额由它换算 */
  points: number;
  /** 卡片说明，一行一条 */
  summary: string[];
  /** 标题后的角标，如「限时抢领」 */
  badge?: string;
  /** 按钮文案，默认「立即领取」 */
  ctaLabel?: string;
  period: ClaimPeriod;
  /** 活动开始日（含），Asia/Shanghai，YYYY-MM-DD；留空=不限 */
  startsOn?: string;
  /** 活动结束日（含），Asia/Shanghai，YYYY-MM-DD；留空=不限 */
  endsOn?: string;
  /** 只在每周这些天可领，0=周日 … 6=周六；留空=每天可领 */
  weekdays?: number[];
  /** 非可领日的提示文案，默认「今日不可领取」 */
  closedHint?: string;
  /** 卡片高亮（限时主推） */
  featured?: boolean;
  /** false = 下架：既不展示也不再发放 */
  enabled?: boolean;
};

/** 单张卡片的展示状态 */
export type ActivityState = 'claimable' | 'claimed' | 'not-started' | 'ended' | 'closed';

export type ActivityView = {
  id: string;
  title: string;
  points: number;
  /** 换算后的到账金额（元），弹窗与副标题用 */
  amountYuan: number;
  summary: string[];
  badge?: string;
  /** 活动起止日（Asia/Shanghai，YYYY-MM-DD）；留空表示不限 */
  startsOn?: string;
  endsOn?: string;
  featured: boolean;
  state: ActivityState;
  disabled: boolean;
  /** 按钮上的字：可领时是 ctaLabel，其余状态是「已领取 / 已结束 / …」 */
  buttonLabel: string;
  /** 非可领状态的原因说明，可领时为 null */
  statusLabel: string | null;
};

export type ActivityOverview = {
  activities: ActivityView[];
  /** 近一年领取汇总：累计算力值与次数 */
  totals: { points: number; count: number };
  /** 领取记录读取失败（页面仍可展示，但「已领取」可能不准） */
  degraded: boolean;
};
