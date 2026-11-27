/**
 * 把「开户默认限流」补写到**存量用户**（一次性动作，由设置页按钮触发）。
 *
 * 语义（与 design 对齐）：
 * - 默认只补「当前没有限流」的用户：`rate_limit` 已非空的用户跳过，不覆盖管理员调过的值；
 * - `overwrite: true` 时连已配置的用户一起**刷新**成本次的默认值（显式选择才生效）；
 * - 每一笔都是显式写 `{ rpm?, tpm? }`，两维都未配置时直接拒绝执行（否则等于把所有人清成不限）；
 * - 失败逐条吞掉并计数，不因为一个用户失败就中断整批。
 *
 * 开户路径本身不依赖这里：新用户由 `provisionUser` 在创建时就带上 `rate_limit`，
 * 网关只在「真正建号」时写入。
 */

import { getConfig } from '@/lib/config';
import { readDefaultRateLimit, toGatewayRateLimit } from '@/lib/config/quota';
import { getGatewayClient, type GatewayClient } from './client';
import type { GatewayListResponse, GatewayUser } from './types';

/** 单页大小上限（网关 `page_size` 上限 100）。 */
const PAGE_SIZE = 100;
/** 安全上限：最多扫 100 页，避免异常响应导致死循环。 */
const MAX_PAGES = 100;

export type ApplyDefaultRateLimitOptions = {
  /**
   * 是否连「已有自己的限流配置」的用户一起刷新。默认 `false`：只补空缺，不覆盖。
   * 打开后每一笔都会把该用户的 `rate_limit` 换成当前默认值（两维都换，不保留旧值）。
   */
  overwrite?: boolean;
};

export type ApplyDefaultRateLimitResult = {
  /** 扫过的用户数 */
  scanned: number;
  /** 本次写入成功的用户数（含覆盖） */
  updated: number;
  /** 其中原本就有配置、被本次覆盖的数量 */
  overwritten: number;
  /** 已有配置、按规则跳过（仅 overwrite=false 时可能非 0） */
  skipped: number;
  /** 写入失败 */
  failed: number;
  /** 本次是否处于覆盖模式 */
  overwrite: boolean;
};

export class DefaultRateLimitMissingError extends Error {
  constructor() {
    super('未配置开户默认限流：请先填写默认 RPM 或默认 TPM');
    this.name = 'DefaultRateLimitMissingError';
  }
}

/**
 * 逐页扫 `GET /api/admin/users`，对 `rate_limit == null` 的用户 `PATCH` 默认限流。
 * 只处理本门户的 `external_system`，不碰同一实例上其它系统建的用户。
 */
export async function applyDefaultRateLimitToUsers(
  options: ApplyDefaultRateLimitOptions = {},
  client: GatewayClient = getGatewayClient()
): Promise<ApplyDefaultRateLimitResult> {
  const cfg = getConfig();
  const rateLimit = toGatewayRateLimit(readDefaultRateLimit(cfg));
  if (!rateLimit) throw new DefaultRateLimitMissingError();

  const overwrite = options.overwrite === true;
  const result: ApplyDefaultRateLimitResult = {
    scanned: 0,
    updated: 0,
    overwritten: 0,
    skipped: 0,
    failed: 0,
    overwrite,
  };

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const listed = await client.admin<GatewayListResponse<GatewayUser>>('/api/admin/users', {
      query: {
        external_system: cfg.octafuse.externalSystem,
        page,
        page_size: PAGE_SIZE,
      },
    });
    const rows = listed?.data ?? [];
    if (rows.length === 0) break;

    for (const user of rows) {
      result.scanned += 1;
      const hadLimit = user.rate_limit != null;
      if (hadLimit && !overwrite) {
        result.skipped += 1;
        continue;
      }
      try {
        await client.admin(`/api/admin/users/${encodeURIComponent(user.id)}`, {
          method: 'PATCH',
          body: {
            rate_limit: rateLimit,
            reason: overwrite ? 'portal:default_rate_limit_refresh' : 'portal:default_rate_limit',
          },
        });
        result.updated += 1;
        if (hadLimit) result.overwritten += 1;
      } catch {
        result.failed += 1;
      }
    }

    const total = typeof listed?.total === 'number' ? listed.total : result.scanned;
    if (result.scanned >= total) break;
  }

  return result;
}
