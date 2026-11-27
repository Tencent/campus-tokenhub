/**
 * 供应商推荐清单的构造器。
 *
 * 三个云厂商的模型条目形状完全一致（`OnboardingPresetModel`），差异只在 id、价格与路由操作。
 * 这里把「对话 / 图像 / 向量」三种条目收敛成三个小函数，preset 文件里只写数据，不重复模板代码。
 *
 * 价格口径：元 / 百万 tokens；图像为元 / 张。与网关 `pricing_profile` 一致。
 */

import type {
  OnboardingPresetModel,
  OnboardingPricingProfile,
  OnboardingRoutePolicy,
} from '../types';

export type ModelModality = 'text' | 'image' | 'video' | 'audio';

/** 阶梯价：`upto` 是输入长度上界（token），末档为 null */
export type TokenTier = {
  upto: number | null;
  label?: string | null;
  input: number;
  output: number;
  cacheRead?: number;
};

type ScheduleWindow = NonNullable<OnboardingPricingProfile['schedule']>;

type RouteInput = {
  /** 上游真实模型名；同款模型跨厂商共用网关 id 时填写 */
  providerModelName?: string;
  /** 同层权重（整数 ≥ 1） */
  weight?: number;
  /** 模型级路由策略；同款模型跨厂商时使用 */
  routePolicy?: OnboardingRoutePolicy;
  /** 峰谷时段；模型与路由两侧必须使用同一组窗口 */
  schedule?: ScheduleWindow;
};

export type ChatModelInput = RouteInput & {
  id: string;
  name: string;
  vendor: string;
  contextWindow: number;
  maxTokens: number | null;
  inputModalities: ModelModality[];
  tiers: TokenTier[];
  recommended?: boolean;
  needsPostpaid?: boolean;
};

export type ImageModelInput = RouteInput & {
  id: string;
  name: string;
  vendor: string;
  /** 元 / 张 */
  price: number;
  recommended?: boolean;
};

export type EmbeddingModelInput = RouteInput & {
  id: string;
  name: string;
  vendor: string;
  contextWindow: number;
  /** 元 / 百万 tokens */
  price: number;
  recommended?: boolean;
};

function priceOverride(schedule: ScheduleWindow | undefined) {
  const windows = schedule?.length ? schedule : null;
  return {
    charged_factor: 1,
    metered_factor: 1,
    ...(windows
      ? {
          schedule: {
            mode: 'multiply',
            charged: windows.map((slot) => ({ ...slot, factor: 1 })),
            metered: windows.map((slot) => ({ ...slot, factor: 1 })),
          },
        }
      : {}),
  };
}

function route(input: RouteInput & { id: string }, upstreamOperation: string) {
  return {
    providerModelName: input.providerModelName ?? input.id,
    status: 'active' as const,
    priority: 0,
    weight: input.weight ?? 1,
    upstreamProtocol: 'openai',
    upstreamOperation,
    priceOverride: priceOverride(input.schedule),
  };
}

function routePolicy(input: RouteInput) {
  return input.routePolicy === undefined ? {} : { routePolicy: input.routePolicy };
}

export function chatModel(input: ChatModelInput): OnboardingPresetModel {
  return {
    id: input.id,
    displayName: input.name,
    vendor: input.vendor,
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    inputModalities: input.inputModalities,
    outputModalities: ['text'],
    pricingProfile: {
      tiers: input.tiers.map((tier) => ({
        upto: tier.upto,
        label: tier.label ?? null,
        input_price: tier.input,
        output_price: tier.output,
        ...(tier.cacheRead === undefined ? {} : { cache_read_price: tier.cacheRead }),
      })),
      ...(input.schedule?.length ? { schedule: input.schedule } : {}),
    },
    ...routePolicy(input),
    recommended: input.recommended ?? true,
    needsPostpaid: input.needsPostpaid ?? false,
    route: route(input, 'chat'),
  };
}

export function imageModel(input: ImageModelInput): OnboardingPresetModel {
  return {
    id: input.id,
    displayName: input.name,
    vendor: input.vendor,
    contextWindow: null,
    maxTokens: null,
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    pricingProfile: { image_billing_mode: 'per_image', image: { default: input.price } },
    ...routePolicy(input),
    recommended: input.recommended ?? true,
    // 图像模型按张计费，上游需要先开通对应服务；一次 402 会熔断整个供应商
    needsPostpaid: true,
    route: route(input, 'images.generations'),
  };
}

export function embeddingModel(input: EmbeddingModelInput): OnboardingPresetModel {
  return {
    id: input.id,
    displayName: input.name,
    vendor: input.vendor,
    contextWindow: input.contextWindow,
    maxTokens: null,
    inputModalities: ['text'],
    outputModalities: ['embedding'],
    pricingProfile: {
      tiers: [{ upto: null, label: null, input_price: input.price, output_price: 0 }],
    },
    ...routePolicy(input),
    recommended: input.recommended ?? true,
    needsPostpaid: false,
    route: route(input, 'embeddings'),
  };
}
