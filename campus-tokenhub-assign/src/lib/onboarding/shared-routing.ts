/**
 * 同款模型跨厂商共用路由池。
 *
 * 网关的 `model_routes` 是按 `model_id` 归到同一个路由池的：同一个 `model_id` 下挂多条
 * 指向不同 provider 的路由，就会在该池内按 `weight` 分流（策略由 `models.route_policy`
 * 或全局 `ROUTE_STRATEGY` 决定）。
 *
 * 因此「同款模型」在门户侧必须用**同一个网关模型 id**，各厂商真实的上游模型名放在
 * `route.providerModelName` 里。比如 DeepSeek V4.1 Flash：
 * - 腾讯云：`deepseek-v4.1-flash-1017`
 * - 阿里云：`deepseek-v4.1-flash-1017`
 * - 火山：`deepseek-v4-1-flash-261017`
 * 三家共用网关模型 id `deepseek-v4.1-flash-1017`，路由各带 weight。
 *
 * 默认权重腾讯云 8、阿里云 1、火山 1（主线路约 80% 流量）；策略用 `weighted_random`，
 * 需要主备或倾斜时在网关后台改 `model_routes.weight` / `models.route_policy` 即可，
 * 门户重跑不会覆盖单条路由以外的字段。
 */

import type { OnboardingPreset, OnboardingPresetModel, OnboardingRoutePolicy } from './types';

/** 三家上游都能提供的同款模型（使用腾讯云已有的 id 作为网关模型 id）。 */
export const SHARED_MODEL_IDS = [
  'deepseek-v4.1-flash-1017',
  'kimi-k3.1-pro',
  'glm-5.3',
  'glm-5.3-flash',
] as const;

const SHARED = new Set<string>(SHARED_MODEL_IDS);

/** 默认按权重随机分流；需要缓存亲和时改成 hash_affinity，主备时改成 weight_priority。 */
export const SHARED_ROUTE_STRATEGY = 'weighted_random' as const;

/**
 * 各家在同款模型路由池里的默认权重（8:1:1）。
 * 腾讯云是学校的主线路，承担约 80% 流量；阿里云 / 火山各约 10%。
 */
export const SHARED_ROUTE_WEIGHTS = {
  tencent: 8,
  aliyun: 1,
  volcano: 1,
} as const;

export const SHARED_ROUTE_POLICY: OnboardingRoutePolicy = { strategy: SHARED_ROUTE_STRATEGY };

export function isSharedModel(id: string): boolean {
  return SHARED.has(id);
}

/** 给同款模型补上权重与路由策略；其它模型保持原样。 */
export function applySharedRouting(preset: OnboardingPreset, weight: number): OnboardingPreset {
  if (!preset.models.some((model) => SHARED.has(model.id))) return preset;
  return {
    ...preset,
    models: preset.models.map((model) =>
      SHARED.has(model.id) ? withSharedRouting(model, weight) : model
    ),
  };
}

function withSharedRouting(model: OnboardingPresetModel, weight: number): OnboardingPresetModel {
  return {
    ...model,
    routePolicy: SHARED_ROUTE_POLICY,
    route: { ...model.route, weight },
  };
}
