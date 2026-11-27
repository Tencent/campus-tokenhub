/**
 * 初始化计划：把 preset 与网关现状比对，产出 create / update / skip。
 *
 * 纯函数，不发起请求——先让管理员看清「会改什么」再执行，
 * 也方便单测覆盖「已存在/已改价/强制覆盖」这些分支。
 */

import type { GatewayClient } from '@/lib/gateway/client';
import { getGatewayClient } from '@/lib/gateway/client';
import type { AdminModelRow, AdminProviderRow, AdminRouteRow } from './gateway-state';
import {
  listModels,
  listProviders,
  listRoutesByProvider,
  parseJsonField,
  readSystemConfig,
} from './gateway-state';
import { CURRENT_PRESET } from './preset';
import type { OnboardingPlan, OnboardingPreset, PlanAction, PlanItem } from './types';

export type GatewaySnapshot = {
  provider: AdminProviderRow | null;
  models: Map<string, AdminModelRow>;
  routes: Map<string, AdminRouteRow>;
  config: Map<string, string>;
};

export async function loadSnapshot(
  client: GatewayClient = getGatewayClient(),
  preset: OnboardingPreset = CURRENT_PRESET
): Promise<GatewaySnapshot> {
  const [providers, models, routes, config] = await Promise.all([
    listProviders(client),
    listModels(client),
    listRoutesByProvider(preset.provider.id, client),
    readSystemConfig(client),
  ]);

  return {
    provider: providers.find((item) => item.id === preset.provider.id) ?? null,
    models: new Map(models.map((model) => [model.id, model])),
    routes: new Map(routes.map((route) => [route.model_id, route])),
    config,
  };
}

export type PlanInput = {
  preset?: OnboardingPreset;
  selectedModelIds: string[];
  hasApiKey: boolean;
  forceOverwrite: boolean;
  snapshot: GatewaySnapshot;
};

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function count(action: PlanAction | undefined, summary: { create: number; update: number; skip: number }): void {
  if (action === 'create') summary.create += 1;
  else if (action === 'update') summary.update += 1;
  else if (action === 'skip') summary.skip += 1;
}

function planProvider(
  preset: OnboardingPreset,
  snapshot: GatewaySnapshot,
  hasApiKey: boolean
): PlanItem & { id: string } {
  const id = preset.provider.id;
  const existing = snapshot.provider;
  if (!existing) {
    return { id, action: 'create', reasons: ['网关中还没有这个供应商'] };
  }

  const reasons: string[] = [];
  if (hasApiKey) reasons.push('写入学校自己的 Key');
  const currentEndpoints = parseJsonField(existing.endpoints);
  const endpointsChanged = !sameJson(currentEndpoints, preset.provider.endpoints);
  if (endpointsChanged) reasons.push('上游地址与推荐清单不一致');
  if (!hasApiKey && endpointsChanged) reasons.push('保留网关里已有的 Key');

  if (reasons.length === 0) {
    return {
      id,
      action: 'skip',
      reasons: [hasApiKey ? '已存在且无需变更' : '复用网关里已保存的 Key，不修改供应商配置'],
    };
  }
  return { id, action: 'update', reasons };
}

/** 模态是官方能力口径，与定价无关：字符串 JSON 与数组都按集合比较，顺序不同不算差异。 */
function sameModalities(current: unknown, next: string[] | null | undefined): boolean {
  if (!next) return true;
  const parsed = parseJsonField(current);
  if (!Array.isArray(parsed)) return false;
  const a = parsed.map((item) => String(item)).sort();
  const b = next.map((item) => String(item)).sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function modalitiesDiffer(existing: AdminModelRow, model: OnboardingPreset['models'][number]): boolean {
  return (
    !sameModalities(existing.input_modalities, model.inputModalities) ||
    !sameModalities(existing.output_modalities, model.outputModalities)
  );
}

function planModel(
  preset: OnboardingPreset,
  modelId: string,
  snapshot: GatewaySnapshot,
  forceOverwrite: boolean
): PlanItem & { id: string } {
  const model = preset.models.find((item) => item.id === modelId);
  if (!model) return { id: modelId, action: 'skip', reasons: ['推荐清单里没有这个模型'] };

  const existing = snapshot.models.get(modelId);
  if (!existing) return { id: modelId, action: 'create', reasons: ['网关中还没有这个模型'] };

  // 能力口径（输入/输出模态）始终对齐：老版本清单漏标的图片/视频输入，重跑初始化就能补上，
  // 不需要勾「强制覆盖」，也不会因此改动定价、上下文与折扣。
  const modalityDrift = modalitiesDiffer(existing, model);
  // 同款模型跨厂商共用路由池时，模型级策略必须一致；这项也不涉及定价，始终对齐。
  const policyDrift =
    model.routePolicy !== undefined &&
    model.routePolicy !== null &&
    !sameJson(parseJsonField(existing.route_policy), model.routePolicy);

  if (modalityDrift || policyDrift) {
    const reasons: string[] = [];
    if (modalityDrift) reasons.push('对齐输入/输出模态（不改定价、上下文与折扣）');
    if (policyDrift) reasons.push('对齐同款模型加权路由策略（不改定价与上下文）');
    return { id: modelId, action: 'update', reasons };
  }

  if (!forceOverwrite) {
    return { id: modelId, action: 'skip', reasons: ['已存在且模态一致；未勾选「强制覆盖」时保留网关里现有的定价与配置'] };
  }
  return { id: modelId, action: 'update', reasons: ['按推荐清单覆盖定价与上下文'] };
}

function planRoute(
  preset: OnboardingPreset,
  modelId: string,
  snapshot: GatewaySnapshot,
  forceOverwrite: boolean
): PlanItem & { id: string } {
  const model = preset.models.find((item) => item.id === modelId);
  if (!model) return { id: modelId, action: 'skip', reasons: ['推荐清单里没有这个模型'] };

  const existing = snapshot.routes.get(modelId);
  if (!existing) return { id: modelId, action: 'create', reasons: ['还没有指向该供应商的路由'] };

  // 权重是路由池分流的核心配置：不勾「强制覆盖」也要对齐，但只改 weight，不碰定价与折扣。
  const presetWeight = model.route.weight ?? 1;
  const currentWeight = existing.weight ?? 1;
  if (!forceOverwrite) {
    if (currentWeight !== presetWeight) {
      return { id: modelId, action: 'update', reasons: [`对齐路由权重 ${currentWeight} → ${presetWeight}（不改定价与折扣）`] };
    }
    return { id: modelId, action: 'skip', reasons: ['路由已存在且权重一致；未勾选「强制覆盖」时不改动'] };
  }
  return { id: modelId, action: 'update', reasons: ['按推荐清单覆盖路由配置、权重与折扣'] };
}

export function buildPlan(input: PlanInput): OnboardingPlan {
  const preset = input.preset ?? CURRENT_PRESET;
  const summary = { create: 0, update: 0, skip: 0 };

  const provider = planProvider(preset, input.snapshot, input.hasApiKey);
  count(provider.action, summary);

  const selected = preset.models.filter((model) => input.selectedModelIds.includes(model.id));
  const models = selected.map((model) => {
    const item = planModel(preset, model.id, input.snapshot, input.forceOverwrite);
    count(item.action, summary);
    return item;
  });

  const routes = selected.map((model) => {
    const item = planRoute(preset, model.id, input.snapshot, input.forceOverwrite);
    count(item.action, summary);
    return item;
  });

  const config = Object.entries(preset.systemConfig).map(([key, value]) => {
    const current = input.snapshot.config.get(key);
    if (current === value) {
      const item = { key, value, action: 'skip' as const, reasons: ['与推荐值一致'] };
      count(item.action, summary);
      return item;
    }
    const item = {
      key,
      value,
      action: current === undefined || input.forceOverwrite ? ('update' as const) : ('skip' as const),
      reasons: [current === undefined ? '缺失，按推荐值写入' : '当前值不同；需要勾选「强制覆盖」才会改写'],
    };
    count(item.action, summary);
    return item;
  });

  return { provider, models, routes, config, summary };
}
