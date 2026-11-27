/** 密钥与调用日志。密钥明文只在服务端流转，接口路由负责决定给不给前端。 */

import { getGatewayClient, GatewayError, type GatewayClient } from './client';
import type { GatewayKey, GatewayListResponse, GatewayRequestLog } from './types';

/** 密钥掩码：保留前缀与末 4 位，中间固定打点。列表接口一律只给这个值。 */
export function maskGatewayKey(key: string): string {
  const value = (key ?? '').trim();
  if (!value) return '';
  if (value.length <= 16) return `${value.slice(0, 4)}••••`;
  return `${value.slice(0, 12)}••••••••${value.slice(-4)}`;
}

/** 裁剪成前端要用的字段，避免把 admin 视角的 user_id / metadata 一并透传 */
function toPortalKey(raw: GatewayKey): GatewayKey {
  return {
    id: raw.id,
    // 明文不离开服务端：页面 SSR / RSC 载荷里只出现掩码，复制时再按需拉一次
    key: maskGatewayKey(raw.key),
    name: raw.name ?? null,
    status: raw.status,
    last_used_at: raw.last_used_at ?? null,
    created_at: raw.created_at ?? null,
  };
}

/** 网关原始列表（含明文）；只在服务端流转，不直接返回前端。 */
async function listRawKeys(
  userId: string,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayKey[]> {
  const response = await client.admin<GatewayListResponse<GatewayKey>>(
    `/api/admin/users/${encodeURIComponent(userId)}/keys`
  );
  return response?.data ?? [];
}

export async function listKeys(
  userId: string,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayKey[]> {
  return (await listRawKeys(userId, client)).map(toPortalKey);
}

export async function createKey(
  userId: string,
  name: string,
  client: GatewayClient = getGatewayClient()
): Promise<{ key: string; keyId: string }> {
  const response = await client.admin<{ data?: { key?: string; key_id?: string } }>(
    '/api/admin/keys',
    { method: 'POST', body: { user_id: userId, name } }
  );

  const key = response?.data?.key;
  const keyId = response?.data?.key_id;
  if (!key || !keyId) throw new GatewayError('网关未返回密钥明文', 502, 'key_create_failed');
  return { key, keyId };
}

/** 404 视为「已经不存在」，对调用方来说是成功。 */
export async function revokeKey(
  keyId: string,
  client: GatewayClient = getGatewayClient()
): Promise<{ alreadyGone: boolean }> {
  try {
    await client.admin(`/api/admin/keys/${encodeURIComponent(keyId)}`, { method: 'DELETE' });
    return { alreadyGone: false };
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return { alreadyGone: true };
    throw error;
  }
}

export async function hasActiveKey(
  userId: string,
  client: GatewayClient = getGatewayClient()
): Promise<boolean> {
  const keys = await listKeys(userId, client);
  return keys.some((key) => key.status === 'active');
}

export async function getUserLogs(
  userId: string,
  limit = 10,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayRequestLog[]> {
  const response = await client.admin<GatewayListResponse<GatewayRequestLog>>(
    `/api/admin/users/${encodeURIComponent(userId)}/logs`,
    { query: { page_size: limit, limit } }
  );
  return response?.data ?? [];
}

export type LogsPage = {
  items: GatewayRequestLog[];
  total: number;
};

/**
 * 调用明细的一页数据。
 *
 * 网关 `/logs` 已支持 `page` / `page_size` / `status`，因此分页与状态筛选都放服务端；
 * 不支持按模型、密钥、时间范围过滤，这些条件只能先在前端隐藏而不是假的过滤。
 */
export async function getLogsPage(
  userId: string,
  options: { page?: number; pageSize?: number; status?: string; modelId?: string } = {},
  client: GatewayClient = getGatewayClient()
): Promise<LogsPage> {
  const pageSize = options.pageSize ?? 20;
  const page = options.page ?? 1;
  const query: Record<string, string | number> = { page, page_size: pageSize, limit: pageSize };
  if (options.status) query.status = options.status;
  if (options.modelId) query.model_id = options.modelId;

  const response = await client.admin<GatewayListResponse<GatewayRequestLog>>(
    `/api/admin/users/${encodeURIComponent(userId)}/logs`,
    { query }
  );

  return { items: response?.data ?? [], total: Number(response?.total ?? 0) };
}

/** 取当前生效的那把密钥（一人一把，取最新 active）。返回**明文**，仅供 /api/portal/key 使用。 */
export async function getActiveKey(
  userId: string,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayKey | null> {
  const keys = await listRawKeys(userId, client);
  return keys.find((key) => key.status === 'active') ?? null;
}
