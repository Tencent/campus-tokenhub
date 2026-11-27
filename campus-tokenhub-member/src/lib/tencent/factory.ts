/**
 * 组织接口客户端的工厂。
 *
 * 生产路径永远返回真实客户端；`MEMBER_ACCOUNT_PROVIDER=mock` 只在本地 / 回归时使用，
 * 配置层已保证它在 `NODE_ENV=production` 下直接抛错（否则会「假装建号成功」）。
 */

import { getConfig } from '@/lib/config';
import { createMockOrganizationClient } from './mock-client';
import { createOrganizationClient, type OrganizationClient } from './organization';

let cached: OrganizationClient | null = null;
let cachedKey: string | null = null;

export function getOrganizationClient(): OrganizationClient {
  const cfg = getConfig();
  const key = `${cfg.memberAccount.provider}:${cfg.tencentCloud.secretId}:${cfg.tencentCloud.region}:${cfg.tencentCloud.endpoint}`;

  if (cached && cachedKey === key) return cached;

  cached =
    cfg.memberAccount.provider === 'mock'
      ? createMockOrganizationClient()
      : createOrganizationClient({
          secretId: cfg.tencentCloud.secretId,
          secretKey: cfg.tencentCloud.secretKey,
          region: cfg.tencentCloud.region,
          endpoint: cfg.tencentCloud.endpoint,
        });
  cachedKey = key;
  return cached;
}

/** 仅测试用：丢掉缓存，换一套配置重新创建。 */
export function resetOrganizationClientCache(): void {
  cached = null;
  cachedKey = null;
}
