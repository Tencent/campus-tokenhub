/**
 * 初始化流程要用到的网关管理端只读/读配置能力。
 *
 * 只封装本流程需要的字段，避免把 admin 视角的其它字段带进门户。
 * 写操作在 `apply.ts` 里单独做，读和写不混在一个模块。
 */

import type { GatewayClient } from '@/lib/gateway/client';
import { GatewayError, getGatewayClient } from '@/lib/gateway/client';

export type AdminProviderRow = {
  id: string;
  name: string;
  kind?: string;
  status?: string;
  endpoints?: unknown;
  /** admin 接口返回的是脱敏预览（如 `sk-…x7Kp`），不是明文 */
  api_key?: string;
};

export type AdminModelRow = {
  id: string;
  display_name: string | null;
  vendor: string;
  context_window: number | null;
  max_tokens: number | null;
  pricing_profile: unknown;
  input_modalities: unknown;
  output_modalities: unknown;
  /** 模型级路由策略（TEXT JSON 或对象）；同款模型跨厂商时用来指定加权策略 */
  route_policy?: unknown;
};

export type AdminRouteRow = {
  id: string;
  model_id: string;
  provider_id: string;
  provider_model_name: string;
  status: string;
  priority: number | null;
  /** 同层权重；同款模型跨厂商共用一个路由池时按它分流 */
  weight?: number | null;
  price_override: unknown;
};

export type AdminConfigRow = {
  key: string;
  value: string;
};

/** admin 接口的 JSON 字段既可能是对象，也可能是字符串，统一在这里收口。 */
export function parseJsonField(value: unknown): unknown {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

export async function listProviders(
  client: GatewayClient = getGatewayClient()
): Promise<AdminProviderRow[]> {
  const response = await client.admin<{ data?: AdminProviderRow[] }>('/api/admin/providers');
  return response?.data ?? [];
}

export async function listModels(
  client: GatewayClient = getGatewayClient()
): Promise<AdminModelRow[]> {
  const response = await client.admin<{ data?: AdminModelRow[] }>('/api/admin/models');
  return response?.data ?? [];
}

export async function listRoutesByProvider(
  providerId: string,
  client: GatewayClient = getGatewayClient()
): Promise<AdminRouteRow[]> {
  const response = await client.admin<{ data?: AdminRouteRow[] }>('/api/admin/routes', {
    query: { provider_id: providerId },
  });
  return response?.data ?? [];
}

/**
 * 已保存 Key 的展示指纹：admin 列表里是 `sk-…x7Kp` 这类脱敏值。
 * `(empty)` / `***` 表示没有可用密钥（供应商存在但没填过自动导入占位/空串）。
 */
export function providerKeyHint(provider: AdminProviderRow | null | undefined): string | null {
  const masked = typeof provider?.api_key === 'string' ? provider.api_key.trim() : '';
  if (!masked || masked === '(empty)' || masked === '***') return null;
  return masked;
}

/**
 * 读网关里保存的明文 Key，仅用于服务端探测上游（不返回前端、不写日志）。
 * 供应商不存在（404）时返回 null，其余错误照常抛出。
 */
export async function revealProviderApiKey(
  providerId: string,
  client: GatewayClient = getGatewayClient()
): Promise<string | null> {
  try {
    const response = await client.admin<{ data?: { api_key?: string }; api_key?: string }>(
      `/api/admin/providers/${encodeURIComponent(providerId)}/api-key`
    );
    const value = response?.data?.api_key ?? response?.api_key;
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed.length > 0 ? trimmed : null;
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) return null;
    throw error;
  }
}

export async function readSystemConfig(
  client: GatewayClient = getGatewayClient()
): Promise<Map<string, string>> {
  const response = await client.admin<{ data?: AdminConfigRow[] }>('/api/admin/config');
  return new Map((response?.data ?? []).map((row) => [row.key, row.value ?? '']));
}

export async function writeSystemConfig(
  key: string,
  value: string,
  client: GatewayClient = getGatewayClient()
): Promise<void> {
  await client.admin('/api/admin/config', { method: 'PUT', body: { key, value } });
}
