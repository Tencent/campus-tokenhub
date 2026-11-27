/**
 * 开户默认额度与默认限流的运行期配置。
 *
 * 与成员站（member）的差异：统一采买站没有门户模式概念，本文件不再承担模式开关；
 * 成员站对应文件里的模式部分已整体删除。
 */

import { getConfig, type AppConfig } from '@/lib/config';

export type DefaultBudget = { budgetMax: number; budgetPeriod: string };

/** 开户写入网关的默认额度（已合并运行期配置）。 */
export function readDefaultBudget(config: AppConfig = getConfig()): DefaultBudget {
  return {
    budgetMax: config.defaults.budgetMax,
    budgetPeriod: config.defaults.budgetPeriod,
  };
}

export type DefaultRateLimit = { rpm: number | null; tpm: number | null };

/** 开户写入网关的默认限流（已合并运行期配置）。两维都可能为 null。 */
export function readDefaultRateLimit(config: AppConfig = getConfig()): DefaultRateLimit {
  return {
    rpm: config.defaults.rateLimitRpm,
    tpm: config.defaults.rateLimitTpm,
  };
}

/**
 * 折成网关 `rate_limit` 的 payload：两维都未配置 → null（不发该字段）。
 * `0` 是有效值（拒绝全部），只有 null 才表示不限，所以这里不能用 `||`。
 */
export function toGatewayRateLimit(limit: DefaultRateLimit): { rpm?: number; tpm?: number } | null {
  if (limit.rpm == null && limit.tpm == null) return null;
  const out: { rpm?: number; tpm?: number } = {};
  if (limit.rpm != null) out.rpm = limit.rpm;
  if (limit.tpm != null) out.tpm = limit.tpm;
  return out;
}
