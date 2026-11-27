/**
 * 网关侧的领取流水与加额。
 *
 * 防重复领取的核心在网关：加额接口 `POST /api/admin/users/:id/wallet/credit` 用
 * `external_ref` 作为幂等键（`user_audit_logs.dedup_key`，同用户唯一），
 * 同一周期重放只会返回 `duplicate`，不会重复加钱。门户不另存领取记录，
 * 一律以网关审计流水为准，避免两份数据对不上。
 */

import { GatewayError, getGatewayClient, type GatewayClient } from '@/lib/gateway/client';
import type { GatewayListResponse } from '@/lib/gateway/types';
import { claimExternalRef, parseClaimRef, pointsToYuan } from './rules';
import type { TokenActivityConfig } from './types';

/** 一次活动发放（来自 `user_audit_logs` 的 wallet_credit 行） */
export type ActivityClaimRecord = {
  externalRef: string;
  activityId: string;
  /** 实际到账金额（元） */
  amountYuan: number;
  claimedAt: string | null;
};

type RawAuditLog = {
  id?: string;
  event_type?: string;
  change_payload?: unknown;
  created_at?: string | null;
};

/** `change_payload` 里是 `{ amount, kind, external_ref }` 的 JSON 串（不同驱动也可能是对象） */
function readChangePayload(payload: unknown): Record<string, unknown> | null {
  if (!payload) return null;
  let parsed: unknown = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
}

/** 从审计行解析出一条活动领取记录；非活动发放返回 null */
export function toActivityClaim(raw: RawAuditLog): ActivityClaimRecord | null {
  const payload = readChangePayload(raw.change_payload);
  const externalRef = typeof payload?.external_ref === 'string' ? payload.external_ref : null;
  if (!externalRef) return null;

  const parsed = parseClaimRef(externalRef);
  if (!parsed) return null;

  const amount = Number(payload?.amount);
  return {
    externalRef,
    activityId: parsed.activityId,
    amountYuan: Number.isFinite(amount) ? amount : 0,
    claimedAt: raw.created_at ?? null,
  };
}

/**
 * 读该用户的加额流水（最多 100 条，网关单页上限）。
 *
 * 只用来渲染「已领取 / 近一年累计」，读失败不影响领取：接口侧还会再查一次，
 * 真正兜底的是网关幂等键。
 */
export async function listActivityClaims(
  userId: string,
  client: GatewayClient = getGatewayClient(),
  pageSize = 100
): Promise<ActivityClaimRecord[]> {
  const response = await client.admin<GatewayListResponse<RawAuditLog>>(
    `/api/admin/users/${encodeURIComponent(userId)}/audit-logs`,
    { query: { event_type: 'wallet_credit', page_size: pageSize } }
  );

  return (response?.data ?? [])
    .map(toActivityClaim)
    .filter((claim): claim is ActivityClaimRecord => claim !== null);
}

export type ActivityCreditResult = {
  /** applied = 本次入账；duplicate = 同周期已领过，未重复发放 */
  status: 'applied' | 'duplicate';
  balanceYuan: number | null;
};

type WalletCreditResponse = {
  success?: boolean;
  status?: string;
  message?: string;
  data?: {
    status?: string;
    walletGranted?: number;
    walletSpent?: number;
    walletBalance?: number;
  };
};

/** 把活动算力值加进永久额度；同周期重放由网关判重 */
export async function creditActivityReward(
  userId: string,
  activity: TokenActivityConfig,
  now: number = Date.now(),
  client: GatewayClient = getGatewayClient()
): Promise<ActivityCreditResult> {
  const response = await client.admin<WalletCreditResponse>(
    `/api/admin/users/${encodeURIComponent(userId)}/wallet/credit`,
    {
      method: 'POST',
      body: {
        amount: pointsToYuan(activity.points),
        // 活动赠额，与充值（topup）区分开，审计里一眼能看出来源
        kind: 'signup_bonus',
        external_ref: claimExternalRef(activity.id, userId, activity.period, now),
        reason: `算力加油包：${activity.title}`,
      },
    }
  );

  const status = response?.data?.status ?? response?.status;
  // 只有明确 `applied` / `duplicate` 才算成功：网关返回失败或字段改名时不能当「已入账」，
  // 否则前端提示领取成功、审计写入假成功，额度实际没加
  if (response?.success === false) {
    throw new GatewayError(response?.message ?? '加额失败', 502, 'wallet_credit_failed');
  }
  if (status !== 'applied' && status !== 'duplicate') {
    throw new GatewayError(`加额返回未知状态：${String(status ?? '')}`, 502, 'wallet_credit_failed');
  }
  const balance = response?.data?.walletBalance;
  return {
    status,
    balanceYuan: typeof balance === 'number' && Number.isFinite(balance) ? balance : null,
  };
}
