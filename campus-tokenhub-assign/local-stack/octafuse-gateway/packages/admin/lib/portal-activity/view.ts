/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 活跃度看板的纯函数：查询串拼装、CSV 行构造、区间预校验、站点文案。
 *
 * 放在 lib 而不是页面里，是为了能在 node 环境直接单测（页面本身依赖 next-intl
 * 与浏览器 API，测试成本高）。
 */

/** 与服务端一致的区间上限；超了前端直接提示，不白跑一次请求 */
export const MAX_RANGE_DAYS = 90;

export type SummaryQueryOptions = {
  site: string;
  sort: string;
  q?: string;
  limit?: number;
};

export const SITE_LABELS: Record<string, string> = {
  all: '全部站点',
  assign: '统一采买',
  member: '成员自购',
};

export function siteLabel(site: string): string {
  return SITE_LABELS[site] ?? site;
}

/**
 * 看板的 range 来自 `useAnalyticsRange`，值是业务时区下的完整时间戳
 * （`2026-11-27 00:00:00`）；`summary` 接口只收 `YYYY-MM-DD`，
 * 直接把时间戳传过去会被 400 拒掉（表现为整页「数据加载失败」）。
 */
export function toDateOnly(value: string): string {
  return value.trim().slice(0, 10);
}

/** 拼 `summary` 接口的查询串；`q` 为空时不带该参数 */
export function buildSummaryQuery(
  range: { start_date: string; end_date: string },
  options: SummaryQueryOptions
): string {
  const params = new URLSearchParams({
    start_date: toDateOnly(range.start_date),
    end_date: toDateOnly(range.end_date),
    site: options.site,
    sort: options.sort,
  });

  const q = (options.q ?? '').trim();
  if (q) params.set('q', q);
  if (options.limit && options.limit > 0) params.set('limit', String(options.limit));

  return params.toString();
}

const DAY_MS = 86_400_000;

/** 区间是否超过服务端上限（含首尾，与 `normalizeRange` 同口径） */
export function isRangeTooLong(startDate: string, endDate: string): boolean {
  const start = Date.parse(`${toDateOnly(startDate)}T00:00:00Z`);
  const end = Date.parse(`${toDateOnly(endDate)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return false;
  return Math.round((end - start) / DAY_MS) + 1 > MAX_RANGE_DAYS;
}

export type CsvUser = {
  name: string | null;
  email: string | null;
  site: string;
  logins: number;
  pageViews: number;
  activeDays: number;
  lastActiveAt: string | null;
};

export const USER_CSV_HEADER = [
  '姓名',
  '邮箱',
  '站点',
  '登录次数',
  '页面访问',
  '活跃天数',
  '最近活跃',
];

/** 排行导出用的二维数组；转义与换行交给 `csvRowsToString` */
export function buildUserCsvRows(users: CsvUser[]): string[][] {
  return [
    [...USER_CSV_HEADER],
    ...users.map((user) => [
      user.name ?? '',
      user.email ?? '',
      siteLabel(user.site),
      String(user.logins),
      String(user.pageViews),
      String(user.activeDays),
      user.lastActiveAt ?? '',
    ]),
  ];
}

/** 指标卡数值展示：整数补千分位，人均保留一位小数 */
export function formatMetric(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Number.isInteger(value)
    ? value.toLocaleString('zh-CN')
    : value.toLocaleString('zh-CN', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
