/**
 * 初始化（开箱即用）用的类型。
 *
 * preset 是「推荐模型清单」的版本化快照：provider 只有地址、没有密钥；
 * 密钥由学校在 /setup 里录入，门户不经手持久化（写进网关 providers 表）。
 */

export type OnboardingRouteStatus = 'active' | 'disabled';

/** 网关支持的同层路由策略（详见网关 docs/developers/reference/route-strategies.md）。 */
export type OnboardingRouteStrategy =
  | 'hash_affinity'
  | 'weighted_random'
  | 'weight_priority'
  | 'weighted_round_robin';

/** 模型级路由策略；只在「同款模型跨厂商共用路由池」时需要显式指定。 */
export type OnboardingRoutePolicy = {
  strategy?: OnboardingRouteStrategy;
  rules?: Record<string, { strategy: OnboardingRouteStrategy }>;
} | null;

export type OnboardingPricingProfile = {
  tiers?: {
    upto?: number | null;
    label?: string | null;
    input_price?: number | null;
    output_price?: number | null;
    cache_read_price?: number | null;
    cache_write_price?: number | null;
  }[];
  schedule?: { start: string; end: string; factor: number; days?: number[]; label?: string | null }[] | null;
  image_billing_mode?: string | null;
  image?: { default?: number | null } | null;
};

export type OnboardingPriceOverride = {
  charged_factor?: number;
  metered_factor?: number;
  provider_factor?: number;
  provider_factor_starts_at?: string | null;
  provider_factor_expires_at?: string | null;
  schedule?: unknown;
} | null;

export type OnboardingPresetModel = {
  id: string;
  displayName: string | null;
  vendor: string;
  contextWindow: number | null;
  maxTokens: number | null;
  inputModalities: string[] | null;
  outputModalities: string[] | null;
  pricingProfile: OnboardingPricingProfile | null;
  /** 模型级路由策略；同款模型（跨厂商）用它把路由池切到按权重分流 */
  routePolicy?: OnboardingRoutePolicy;
  /** 默认勾选；对应「现在这套实例里启用的模型」 */
  recommended: boolean;
  /** 需要在上游开通后付费，否则一次 402 会熔断整个供应商 */
  needsPostpaid: boolean;
  route: {
    providerModelName: string;
    status: OnboardingRouteStatus;
    priority: number;
    /** 同层权重（整数 ≥ 1）；同款模型跨厂商共用一个路由池时按它分流 */
    weight?: number;
    upstreamProtocol: string;
    upstreamOperation: string;
    priceOverride: OnboardingPriceOverride;
  };
};

export type OnboardingPreset = {
  version: string;
  generatedAt: string;
  provider: {
    id: string;
    name: string;
    kind: string;
    endpoints: Record<string, unknown>;
  };
  systemConfig: Record<string, string>;
  models: OnboardingPresetModel[];
};

export type PlanAction = 'create' | 'update' | 'skip';

export type PlanItem = {
  action: PlanAction;
  reasons: string[];
};

export type OnboardingPlan = {
  provider: PlanItem & { id: string };
  models: (PlanItem & { id: string })[];
  routes: (PlanItem & { id: string })[];
  config: (PlanItem & { key: string; value: string })[];
  summary: { create: number; update: number; skip: number };
};

export type ApplyStep = {
  /** 分组：provider / model / route / config */
  group: 'provider' | 'model' | 'route' | 'config';
  target: string;
  action: PlanAction;
  ok: boolean;
  message?: string;
};

export type ApplyResult = {
  ok: boolean;
  completed: boolean;
  steps: ApplyStep[];
  failed: number;
  created: number;
  updated: number;
  skipped: number;
};

export type OnboardingState = {
  completed: boolean;
  completedAt: string | null;
  owner: string | null;
  providerExists: boolean;
  /** 网关里已保存的 Key 掩码指纹（如 `sk-…x7Kp`）；为空表示没有可复用的 Key */
  existingKeyHint: string | null;
  /** 本次 preset 里已在网关存在的模型数 */
  modelCount: number;
  /** 本次 preset 里已在网关存在的模型 id（重跑初始化时用于预勾选） */
  enabledModelIds: string[];
  routeCount: number;
  /** 网关里是否已经有任何 provider（判断是不是全新实例） */
  gatewaySeeded: boolean;
};

export type ProbeResult = {
  ok: boolean;
  /** 上游 `/v1/models` 返回的模型 id；接口不可用但对话可用时为 null */
  models: string[] | null;
  /** 掩码后的 Key 指纹，只用于让用户确认填的是哪一把 */
  keyHint: string;
  error?: string;
  latencyMs: number;
};

/**
 * 上游返回、但推荐清单没收录的模型：价格默认取 `model-catalog.ts` 的腾讯云官方目录价，
 * 请求里显式传价时以显式值为准（给脚本/高级用法留的口子，页面不再要求填写）。
 * token 单价单位与网关一致：元 / 百万 tokens；imagePrice 单位：元 / 张。
 */
export type ExtraModelInput = {
  id: string;
  /** 0 或不传表示用目录价 */
  inputPrice: number;
  outputPrice: number;
  /** 图片生成模型按张计价；有值时忽略 inputPrice/outputPrice */
  imagePrice?: number | null;
  /** 缓存命中价（元/百万 tokens），通常由目录价带出 */
  cacheRead?: number | null;
};
