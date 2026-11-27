/**
 * 初始化状态与 owner 认领。
 *
 * 门户不落盘，状态一律存在网关的 `system_config`：
 * - `ONBOARDING_OWNER`：第一个进入初始化页的身份（`external_user_id`），写一次后不再改
 * - `ONBOARDING_COMPLETED`：腾讯云初始化完成标记（`<ISO 时间>|<owner>`）
 * - `ONBOARDING_COMPLETED_ALIYUN` / `ONBOARDING_COMPLETED_VOLCANO`：阿里云 / 火山完成标记
 *
 * 每个供应商独立记录完成时间：学校可能只接腾讯云，也可能同时接入三家。
 * owner 保持全局唯一——同一套网关只允许一个初始化负责人。
 */

import type { GatewayClient } from '@/lib/gateway/client';
import { getGatewayClient } from '@/lib/gateway/client';
import { withTransaction } from '@/lib/db/portal-db';
import { addAdmin, isValidAdminSub } from '@/lib/admin/roster';
import { CURRENT_PRESET } from './preset';
import { PROVIDER_LIST, providerByPresetId } from './providers';
import type { OnboardingProvider } from './providers';
import {
  listModels,
  listProviders,
  listRoutesByProvider,
  providerKeyHint,
  readSystemConfig,
  writeSystemConfig,
  type AdminProviderRow,
  type AdminRouteRow,
} from './gateway-state';
import type { OnboardingState } from './types';

export const ONBOARDING_OWNER_KEY = 'ONBOARDING_OWNER';
/** 腾讯云（历史键名，保持向后兼容） */
export const ONBOARDING_COMPLETED_KEY = 'ONBOARDING_COMPLETED';

export type OwnerResolution = {
  completed: boolean;
  owner: string | null;
  isOwner: boolean;
  /** 本次调用新认领成功（用于提示「你已成为初始化负责人」） */
  claimed: boolean;
};

export type ProviderOnboardingState = {
  provider: OnboardingProvider;
  state: OnboardingState;
};

function parseCompleted(value: string | undefined): { completed: boolean; completedAt: string | null } {
  if (!value) return { completed: false, completedAt: null };
  const [timestamp] = value.split('|');
  return { completed: true, completedAt: timestamp && timestamp.trim() ? timestamp : null };
}

function ownerFromCompleted(value: string | undefined): string | null {
  if (!value) return null;
  const [, owner] = value.split('|');
  return owner && owner.trim() ? owner.trim() : null;
}

/** 任意一个供应商完成即视为「网关初始化过」；腾讯云排在最前，优先取它的时间。 */
function readAnyCompletion(config: Map<string, string>): {
  completed: boolean;
  completedAt: string | null;
  owner: string | null;
} {
  for (const provider of PROVIDER_LIST) {
    const value = config.get(provider.completionKey);
    if (!value) continue;
    const parsed = parseCompleted(value);
    return { completed: true, completedAt: parsed.completedAt, owner: ownerFromCompleted(value) };
  }
  return { completed: false, completedAt: null, owner: null };
}

function completionKeyOf(preset: { provider: { id: string } }): string {
  return providerByPresetId(preset.provider.id)?.completionKey ?? ONBOARDING_COMPLETED_KEY;
}

function summarizeState(
  preset: { models: { id: string }[]; provider: { id: string } },
  completionKey: string,
  providers: AdminProviderRow[],
  presentIds: Set<string>,
  routes: AdminRouteRow[],
  config: Map<string, string>
): OnboardingState {
  const providerRow = providers.find((item) => item.id === preset.provider.id) ?? null;
  const completedValue = config.get(completionKey);
  const { completed, completedAt } = parseCompleted(completedValue);
  const owner = config.get(ONBOARDING_OWNER_KEY) || ownerFromCompleted(completedValue);
  const enabledModelIds = preset.models
    .filter((model) => presentIds.has(model.id))
    .map((model) => model.id);

  return {
    completed,
    completedAt,
    owner,
    providerExists: providerRow !== null,
    existingKeyHint: providerKeyHint(providerRow),
    modelCount: enabledModelIds.length,
    enabledModelIds,
    routeCount: routes.length,
    gatewaySeeded: providers.length > 0,
  };
}

export async function getOnboardingState(
  client: GatewayClient = getGatewayClient(),
  preset = CURRENT_PRESET
): Promise<OnboardingState> {
  const [providers, models, routes, config] = await Promise.all([
    listProviders(client),
    listModels(client),
    listRoutesByProvider(preset.provider.id, client),
    readSystemConfig(client),
  ]);

  return summarizeState(
    preset,
    completionKeyOf(preset),
    providers,
    new Set(models.map((model) => model.id)),
    routes,
    config
  );
}

/** 初始化页用：一次读齐三个供应商的状态，避免每个 tab 各拉一遍。 */
export async function getProviderStates(
  client: GatewayClient = getGatewayClient()
): Promise<ProviderOnboardingState[]> {
  const [providers, models, config] = await Promise.all([
    listProviders(client),
    listModels(client),
    readSystemConfig(client),
  ]);
  const presentIds = new Set(models.map((model) => model.id));

  return Promise.all(
    PROVIDER_LIST.map(async (provider) => {
      const routes = await listRoutesByProvider(provider.preset.provider.id, client);
      return {
        provider,
        state: summarizeState(provider.preset, provider.completionKey, providers, presentIds, routes, config),
      };
    })
  );
}

/**
 * 已登录身份尝试认领初始化权：没有 owner 时写自己，已有 owner 时只读。
 *
 * 并发唯一性靠 **数据库 advisory lock + 锁内重读**：
 * 只靠「写后读回」时，A 写完立刻读（B 尚未写）→ A 认为自己是 owner；
 * B 写完再读 → B 也认为自己是 owner，两人都会被写进 `portal_shared.admins`。
 * 现在认领动作在同一个事务锁内完成「重读 → 写入 → 再读」，后到者一定能看到先到者。
 * 拿不到数据库（初始化早期）时退回无锁流程，行为与改造前一致，不会更糟。
 */
export async function resolveOwner(
  subject: string,
  client: GatewayClient = getGatewayClient()
): Promise<OwnerResolution> {
  const before = await readSystemConfig(client);
  const completion = readAnyCompletion(before);

  if (completion.completed) {
    const owner = before.get(ONBOARDING_OWNER_KEY) || completion.owner;
    return { completed: true, owner, isOwner: Boolean(owner) && owner === subject, claimed: false };
  }

  const existing = before.get(ONBOARDING_OWNER_KEY);
  if (existing) {
    return { completed: false, owner: existing, isOwner: existing === subject, claimed: false };
  }

  const claimed = await claimOwnerLocked(subject, client).catch(() =>
    claimOwnerUnlocked(subject, client)
  );

  // 首次认领即成为全局管理员：名单与 owner 同时落库，避免出现「两份管理员数据」。
  // 写失败不阻断认领——初始化本身仍要能用，管理员可稍后在 /members/admins 页补。
  // 只接受 `school_id:user_id`：mock / OIDC 的 sub 可能是邮箱，那种身份不该进管理员名单。
  if (claimed.isOwner && isValidAdminSub(subject)) {
    try {
      await addAdmin(subject);
    } catch {
      // 数据库短暂不可用时忽略：owner 已落库，名单兜底仍走 onboarding owner
    }
  }

  return { completed: false, owner: claimed.owner, isOwner: claimed.isOwner, claimed: claimed.isOwner };
}

type OwnerClaim = { owner: string | null; isOwner: boolean };

/** 跨进程互斥认领：锁内重读，先到者写入，后到者直接认已有 owner。 */
async function claimOwnerLocked(subject: string, client: GatewayClient): Promise<OwnerClaim> {
  return withTransaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('portal_onboarding_owner'))");

    // 锁内重读：并发者在等锁期间可能已经写入
    const current = await readSystemConfig(client);
    const owner = current.get(ONBOARDING_OWNER_KEY) || null;
    if (owner) return { owner, isOwner: owner === subject };

    await writeSystemConfig(ONBOARDING_OWNER_KEY, subject, client);
    resetOnboardingCache();
    const after = await readSystemConfig(client);
    const next = after.get(ONBOARDING_OWNER_KEY) || null;
    return { owner: next, isOwner: next === subject };
  });
}

/** 无数据库时的降级认领（与改造前一致）：写后读回。 */
async function claimOwnerUnlocked(subject: string, client: GatewayClient): Promise<OwnerClaim> {
  await writeSystemConfig(ONBOARDING_OWNER_KEY, subject, client);
  resetOnboardingCache();
  const after = await readSystemConfig(client);
  const owner = after.get(ONBOARDING_OWNER_KEY) || null;
  return { owner, isOwner: owner === subject };
}

export async function markCompleted(
  subject: string,
  client: GatewayClient = getGatewayClient(),
  completionKey: string = ONBOARDING_COMPLETED_KEY
): Promise<string> {
  const timestamp = new Date().toISOString();
  await writeSystemConfig(completionKey, `${timestamp}|${subject}`, client);
  resetOnboardingCache();
  return timestamp;
}

/** 供 apply 用：结算本次 preset 对应的供应商完成标记。 */
export function completionKeyForPreset(preset: { provider: { id: string } }): string {
  return completionKeyOf(preset);
}

/**
 * 首页跳转、侧边栏入口与登录后引导只关心「完成状态 + owner」，不需要模型与路由明细。
 *
 * 每次导航都读网关太浪费，这里做 30 秒进程内缓存；认领 owner / 完成初始化时主动失效。
 */
export const COMPLETION_CACHE_MS = 30_000;

export type OnboardingSnapshot = {
  completed: boolean;
  owner: string | null;
};

let snapshotCache: { at: number; snapshot: OnboardingSnapshot } | null = null;

export function resetOnboardingCache(): void {
  snapshotCache = null;
}

/** 读完成状态与 owner；调用方需要自行处理网关异常（这里直接抛出）。 */
export async function readOnboardingSnapshot(
  client: GatewayClient = getGatewayClient()
): Promise<OnboardingSnapshot> {
  const now = Date.now();
  if (snapshotCache && now - snapshotCache.at < COMPLETION_CACHE_MS) {
    return snapshotCache.snapshot;
  }
  const config = await readSystemConfig(client);
  const completion = readAnyCompletion(config);
  const snapshot: OnboardingSnapshot = {
    completed: completion.completed,
    owner: config.get(ONBOARDING_OWNER_KEY) || completion.owner,
  };
  snapshotCache = { at: now, snapshot };
  return snapshot;
}

/** 读不到时按「已完成」处理：宁可少做一次强制跳转，也不让网关故障在每页刷一条错误。 */
export async function isOnboardingCompleted(
  client: GatewayClient = getGatewayClient()
): Promise<boolean> {
  try {
    return (await readOnboardingSnapshot(client)).completed;
  } catch {
    return true;
  }
}
