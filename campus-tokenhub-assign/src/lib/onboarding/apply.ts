/**
 * 执行初始化计划：把 provider / models / routes / system_config 幂等写进网关。
 *
 * 三条约束：
 * 1. 任何一步失败都不回滚已成功的步骤——重跑时靠 upsert 自然补齐，逐条重试即可
 * 2. Key 只在服务端内存里出现，不写日志、不返回给前端
 * 3. 只有全部步骤成功才写 `ONBOARDING_COMPLETED`，避免半成品被当成已完成（完成后可随时重跑）
 */

import type { GatewayClient } from '@/lib/gateway/client';
import { getGatewayClient } from '@/lib/gateway/client';
import { ApiError } from '@/lib/api/guard';
import { resetCatalogCache } from '@/lib/gateway/catalog';
import { buildPlan, loadSnapshot, type GatewaySnapshot } from './plan';
import { revealProviderApiKey } from './gateway-state';
import { CURRENT_PRESET } from './preset';
import { buildExtraPresetModel } from './extra-model';
import { completionKeyForPreset, markCompleted } from './state';
import { writeSystemConfig } from './gateway-state';
import type {
  ApplyResult,
  ApplyStep,
  ExtraModelInput,
  OnboardingPlan,
  OnboardingPreset,
  OnboardingPresetModel,
} from './types';

export type ApplyInput = {
  selectedModelIds: string[];
  /** 学校自己的 TokenHub Key；provider 已存在时可为空（表示不改 Key） */
  apiKey: string | null;
  forceOverwrite: boolean;
  subject: string;
  /** 上游返回但清单未收录的模型：只传 id，价格与参数从静态目录读取 */
  extraModels?: ExtraModelInput[];
  dryRun?: boolean;
  preset?: OnboardingPreset;
  client?: GatewayClient;
};

export type ApplyOutcome = {
  plan: OnboardingPlan;
  result: ApplyResult | null;
};

function routePolicyField(model: OnboardingPresetModel): Record<string, unknown> {
  // 网关把 route_policy 当 TEXT JSON 存，PATCH 传对象会报 "route_policy must be valid JSON"
  return model.routePolicy === undefined || model.routePolicy === null
    ? {}
    : { route_policy: JSON.stringify(model.routePolicy) };
}

function modelCreateBody(model: OnboardingPresetModel): Record<string, unknown> {
  return {
    id: model.id,
    display_name: model.displayName,
    vendor: model.vendor,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    pricing_profile: model.pricingProfile,
    input_modalities: model.inputModalities,
    output_modalities: model.outputModalities,
    ...routePolicyField(model),
    tags: [],
  };
}

function modelUpdateBody(model: OnboardingPresetModel): Record<string, unknown> {
  return {
    display_name: model.displayName,
    vendor: model.vendor,
    context_window: model.contextWindow,
    max_tokens: model.maxTokens,
    pricing_profile: model.pricingProfile,
    input_modalities: model.inputModalities,
    output_modalities: model.outputModalities,
    ...routePolicyField(model),
  };
}

/**
 * 只对齐能力口径与路由策略的 PATCH：未勾「强制覆盖」时用这个。
 *
 * 计划里因模态漂移 / 同款模型加权策略产生的 update 只应改这两项，
 * 绝不能顺带覆盖管理员调过的价格与上下文。
 */
function modelAlignmentBody(model: OnboardingPresetModel): Record<string, unknown> {
  return {
    input_modalities: model.inputModalities,
    output_modalities: model.outputModalities,
    ...routePolicyField(model),
  };
}

function routeCreateBody(
  preset: OnboardingPreset,
  model: OnboardingPresetModel
): Record<string, unknown> {
  return {
    model_id: model.id,
    provider_id: preset.provider.id,
    provider_model_name: model.route.providerModelName,
    status: model.route.status,
    priority: model.route.priority,
    weight: model.route.weight ?? 1,
    upstream_protocol: model.route.upstreamProtocol,
    upstream_operation: model.route.upstreamOperation,
    price_override: model.route.priceOverride,
  };
}

function routeUpdateBody(model: OnboardingPresetModel): Record<string, unknown> {
  return {
    provider_model_name: model.route.providerModelName,
    status: model.route.status,
    priority: model.route.priority,
    weight: model.route.weight ?? 1,
    price_override: model.route.priceOverride,
  };
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // 兜底：任何异常都再过一次 Key 脱敏，避免上游把 Authorization 回显到 message 里
  return raw.replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***').slice(0, 300);
}

async function runStep(
  steps: ApplyStep[],
  counters: { created: number; updated: number; skipped: number; failed: number },
  step: Omit<ApplyStep, 'ok'>,
  action: () => Promise<void>
): Promise<void> {
  if (step.action === 'skip') {
    steps.push({ ...step, ok: true });
    counters.skipped += 1;
    return;
  }
  try {
    await action();
    steps.push({ ...step, ok: true });
    if (step.action === 'create') counters.created += 1;
    else counters.updated += 1;
  } catch (error) {
    steps.push({ ...step, ok: false, message: errorMessage(error) });
    counters.failed += 1;
  }
}

async function applyPlan(
  plan: OnboardingPlan,
  input: Required<Pick<ApplyInput, 'selectedModelIds' | 'forceOverwrite' | 'subject'>> & {
    apiKey: string | null;
    preset: OnboardingPreset;
    client: GatewayClient;
    snapshot: GatewaySnapshot;
  }
): Promise<ApplyResult> {
  const { preset, client } = input;

  const steps: ApplyStep[] = [];
  const counters = { created: 0, updated: 0, skipped: 0, failed: 0 };
  const selected = preset.models.filter((model) => input.selectedModelIds.includes(model.id));

  // 1) provider
  const providerId = preset.provider.id;
  if (plan.provider.action === 'create') {
    await runStep(
      steps,
      counters,
      { group: 'provider', target: providerId, action: 'create' },
      async () => {
        await client.admin('/api/admin/providers', {
          method: 'POST',
          body: {
            id: providerId,
            name: preset.provider.name,
            kind: preset.provider.kind,
            api_key: input.apiKey,
            endpoints: preset.provider.endpoints,
            status: 'active',
          },
        });
      }
    );
  } else if (plan.provider.action === 'update') {
    await runStep(
      steps,
      counters,
      { group: 'provider', target: providerId, action: 'update' },
      async () => {
        await client.admin(`/api/admin/providers/${encodeURIComponent(providerId)}`, {
          method: 'PATCH',
          body: {
            name: preset.provider.name,
            endpoints: preset.provider.endpoints,
            ...(input.apiKey ? { api_key: input.apiKey } : {}),
          },
        });
      }
    );
  } else {
    steps.push({ group: 'provider', target: providerId, action: 'skip', ok: true });
    counters.skipped += 1;
  }

  // 2) models
  for (const model of selected) {
    const item = plan.models.find((entry) => entry.id === model.id);
    if (!item) continue;
    await runStep(
      steps,
      counters,
      { group: 'model', target: model.id, action: item.action },
      async () => {
        if (item.action === 'create') {
          await client.admin('/api/admin/models', { method: 'POST', body: modelCreateBody(model) });
        } else {
          await client.admin(`/api/admin/models/${encodeURIComponent(model.id)}`, {
            method: 'PATCH',
            // 未勾「强制覆盖」时计划里的 update 只来自模态漂移 / 路由策略对齐，
            // 只改这两项，不碰管理员调过的定价与上下文
            body: input.forceOverwrite ? modelUpdateBody(model) : modelAlignmentBody(model),
          });
        }
      }
    );
  }

  // 3) routes
  for (const model of selected) {
    const item = plan.routes.find((entry) => entry.id === model.id);
    if (!item) continue;
    const existing = input.snapshot.routes.get(model.id);
    await runStep(
      steps,
      counters,
      { group: 'route', target: model.id, action: item.action },
      async () => {
        if (item.action === 'create') {
          await client.admin('/api/admin/routes', {
            method: 'POST',
            body: routeCreateBody(preset, model),
          });
          return;
        }
        if (!existing) throw new Error('路由已不存在，请重新执行初始化');
        await client.admin(`/api/admin/routes/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          // 未勾「强制覆盖」时只对齐权重，避免覆盖后台调过的定价 / 折扣
          body: input.forceOverwrite
            ? routeUpdateBody(model)
            : { weight: model.route.weight ?? 1 },
        });
      }
    );
  }

  // 4) system_config
  for (const item of plan.config) {
    await runStep(
      steps,
      counters,
      { group: 'config', target: item.key, action: item.action },
      async () => writeSystemConfig(item.key, item.value, client)
    );
  }

  const failed = counters.failed;
  const ok = failed === 0;
  const completed = ok
    ? Boolean(await completeOnboarding(input.subject, client, completionKeyForPreset(preset)))
    : false;

  return { ok, completed, steps, ...counters };
}

async function completeOnboarding(
  subject: string,
  client: GatewayClient,
  completionKey: string
): Promise<boolean> {
  try {
    await markCompleted(subject, client, completionKey);
    resetCatalogCache();
    return true;
  } catch {
    return false;
  }
}

export async function applyOnboarding(input: ApplyInput): Promise<ApplyOutcome> {
  const basePreset = input.preset ?? CURRENT_PRESET;
  const extraModels = (input.extraModels ?? []).filter(
    (extra) => !basePreset.models.some((model) => model.id === extra.id)
  );
  const preset: OnboardingPreset = extraModels.length
    ? { ...basePreset, models: [...basePreset.models, ...extraModels.map(buildExtraPresetModel)] }
    : basePreset;

  const client = input.client ?? getGatewayClient();
  const snapshot = await loadSnapshot(client, preset);
  const plan = buildPlan({
    preset,
    selectedModelIds: input.selectedModelIds,
    hasApiKey: Boolean(input.apiKey),
    forceOverwrite: input.forceOverwrite,
    snapshot,
  });

  if (plan.provider.action === 'create' && !input.apiKey) {
    throw new ApiError(400, '网关里还没有这个供应商，必须先填写 Key', 'api_key_required');
  }

  // 复用旧 Key：供应商已存在但网关里没存过密钥时，不能让流程「成功」出个连不上上游的实例
  if (!input.apiKey && snapshot.provider) {
    const stored = await revealProviderApiKey(preset.provider.id, client);
    if (!stored) {
      throw new ApiError(400, '网关里没有可复用的 Key，请填写学校的 TokenHub Key', 'api_key_required');
    }
  }

  if (input.dryRun) return { plan, result: null };

  const result = await applyPlan(plan, {
    selectedModelIds: input.selectedModelIds,
    forceOverwrite: input.forceOverwrite,
    subject: input.subject,
    apiKey: input.apiKey,
    preset,
    client,
    snapshot,
  });

  return { plan, result };
}
