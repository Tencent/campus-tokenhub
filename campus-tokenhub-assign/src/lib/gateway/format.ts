/** 网关的时间/额度字段格式化。网关返回的是 `2026-11-05 11:06:00.626+00` 这种写法。 */

import { businessTimeZone } from '@/lib/portal/business-time';

export function parseGatewayTime(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const normalized = raw.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(raw: string | null | undefined): string {
  const date = parseGatewayTime(raw);
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: businessTimeZone(),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDate(raw: string | null | undefined): string {
  const date = parseGatewayTime(raw);
  if (!date) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: businessTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export const BUDGET_PERIOD_LABEL: Record<string, string> = {
  daily: '每日重置',
  monthly: '每月重置',
  none: '不重置',
};

export function budgetPeriodLabel(period: string | null | undefined): string {
  if (!period) return '—';
  return BUDGET_PERIOD_LABEL[period] ?? period;
}
