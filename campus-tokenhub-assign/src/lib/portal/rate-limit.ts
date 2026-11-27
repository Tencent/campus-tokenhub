/**
 * 从网关的用户对象里读「每分钟请求上限」(RPM)。
 *
 * 网关把限流放在用户级 `rate_limit` 字段，未配置时为 null；
 * 但字段结构没有稳定契约（本地实测全是 null），所以这里做防御式解析：
 * 数字、数字字符串、以及几种常见键名的对象都认，认不出来就当没配置。
 *
 * 注意：这里读的是**上限**，不是实测峰值。
 * 实测峰值需要网关在 tpm-series 里按桶返回请求数，目前只返回 token 数。
 */

const RPM_KEYS = ['rpm', 'requests_per_minute', 'requests_per_min', 'req_per_min', 'per_minute', 'limit'];

function positiveNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }
  return null;
}

export function readRpmLimit(rateLimit: unknown): number | null {
  const direct = positiveNumber(rateLimit);
  if (direct !== null) return direct;

  if (rateLimit && typeof rateLimit === 'object') {
    const record = rateLimit as Record<string, unknown>;
    for (const key of RPM_KEYS) {
      const hit = positiveNumber(record[key]);
      if (hit !== null) return hit;
    }
  }

  return null;
}
