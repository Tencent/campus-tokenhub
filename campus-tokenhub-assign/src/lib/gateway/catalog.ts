/**
 * 模型目录：`GET {proxy}/catalog/models`，进程内缓存 60 秒。
 *
 * 拉取失败时若有旧缓存就返回旧值并标 `stale`（页面提示「可能不是最新」），
 * 只有「从来没成功过」才抛错，避免网关抖一下整页 500。
 */

import { resolveCurrentPrice, scheduleHint } from '@/lib/pricing/schedule';
import { getGatewayClient, type GatewayClient } from './client';
import type { CatalogModel } from './types';

/**
 * 门户侧的进程内缓存窗口。
 *
 * 网关自己的公开目录已经缓存 45 秒（没有失效接口），门户再压 60 秒会让「刚初始化完的
 * 模型」最多晚一两分钟才出现在模型页；这里压到 15 秒，只用于扛住同一时刻的并发渲染，
 * 真正的延迟上限交给网关的 45 秒。
 */
export const CATALOG_TTL_MS = 15_000;

export type CatalogSnapshot = {
  models: CatalogModel[];
  /** 本次结果是过期缓存（网关拉取失败） */
  stale: boolean;
  fetchedAt: number;
};

let cache: { models: CatalogModel[]; at: number } | null = null;

export function resetCatalogCache(): void {
  cache = null;
}

function extractModels(payload: unknown): CatalogModel[] {
  if (Array.isArray(payload)) return payload as CatalogModel[];
  const data = (payload as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? (data as CatalogModel[]) : [];
}

export async function getCatalog(
  client: GatewayClient = getGatewayClient(),
  now: number = Date.now()
): Promise<CatalogSnapshot> {
  if (cache && now - cache.at < CATALOG_TTL_MS) {
    return { models: cache.models, stale: false, fetchedAt: cache.at };
  }

  try {
    const response = await client.publicGet<unknown>('/catalog/models');
    const models = extractModels(response);
    cache = { models, at: now };
    return { models, stale: false, fetchedAt: now };
  } catch (error) {
    if (cache) return { models: cache.models, stale: true, fetchedAt: cache.at };
    throw error;
  }
}

export type ChatModelOption = {
  id: string;
  /** 展示名；网关没配时用 id */
  name: string;
  /** 输入模态（text / image / audio…），管理端可能返回 JSON 字符串，统一成数组 */
  inputModalities: string[];
  /** 输出模态；接入指南据此判断能不能接 WorkBuddy（只有输出文本的模型可以） */
  outputModalities: string[];
};

type AdminModelLite = {
  id: string;
  display_name?: string | null;
  /** 一句话简介，卡片上的「适用场景」用它 */
  note?: string | null;
  /** 上架日期（网关侧维护），卡片底部展示 */
  released_at?: string | null;
  input_modalities?: unknown;
  output_modalities?: unknown;
};

/** 管理端把模态字段存成 TEXT，可能是数组，也可能是 JSON 字符串；读不出来就当没有。 */
export function readModalities(raw: unknown): string[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

type AdminRouteLite = {
  model_id?: string;
  status?: string;
  upstream_operation?: string | null;
  /** 字符串或数组；网关把请求面存在这个字段里 */
  surfaces?: unknown;
};

type RouteSurface = {
  protocol: string;
  operation: string;
  status: string;
};

function parseSurfaces(raw: unknown): RouteSurface[] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = (item ?? {}) as Record<string, unknown>;
    const protocol = typeof row.request_protocol === 'string' ? row.request_protocol.trim() : '';
    const operation = typeof row.request_operation === 'string' ? row.request_operation.trim() : '';
    if (!protocol || !operation) return [];
    return [{ protocol, operation, status: String(row.status ?? 'active').toLowerCase() }];
  });
}

/** 这条路由能不能接 OpenAI 兼容的 chat 请求（`*` 是网关的「全操作」通配）。 */
function routeServesChat(route: AdminRouteLite): boolean {
  if (route.status !== 'active') return false;
  const surfaces = parseSurfaces(route.surfaces);
  if (surfaces.length > 0) {
    return surfaces.some(
      (surface) =>
        surface.status !== 'disabled' &&
        surface.protocol === 'openai' &&
        (surface.operation === 'chat' || surface.operation === '*')
    );
  }
  return route.upstream_operation === 'chat';
}

/**
 * 有 active 路由的对话模型（读管理端，不走公开目录的 45 秒缓存）。
 *
 * 公开目录 `/catalog/models` 由网关进程缓存 45 秒、且没有失效接口，门户再缓存 60 秒，
 * 结果就是「刚初始化完的模型在接入指南里要等一两分钟才出现」。接入指南只关心「填哪个模型
 * ID」，这里直接读管理端的模型与路由，导入后立即可见；管理端不可用时由调用方退回公开目录。
 */
export async function listChatModels(
  client: GatewayClient = getGatewayClient()
): Promise<ChatModelOption[]> {
  const [modelsResponse, routesResponse] = await Promise.all([
    client.admin<{ data?: AdminModelLite[] }>('/api/admin/models'),
    client.admin<{ data?: AdminRouteLite[] }>('/api/admin/routes'),
  ]);

  const chatModelIds = new Set(
    (routesResponse?.data ?? [])
      .filter(routeServesChat)
      .map((route) => route.model_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
  );

  return (modelsResponse?.data ?? [])
    .filter((model) => typeof model.id === 'string' && chatModelIds.has(model.id))
    .map((model) => ({
      id: model.id,
      name: model.display_name || model.id,
      inputModalities: readModalities(model.input_modalities),
      outputModalities: readModalities(model.output_modalities),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export type ModelCardMeta = {
  /** 一句话简介（卡片里的「适用场景」） */
  note: string | null;
  /** 上架日期，ISO 字符串 */
  releasedAt: string | null;
};

/**
 * 卡片补充信息：公开目录 `/catalog/models` 不带简介与上架日期，只能读管理端。
 *
 * 读不到时返回空 Map，卡片退化为「无简介、无上架日期」，不影响集市本身可用。
 */
export async function listModelMeta(
  client: GatewayClient = getGatewayClient()
): Promise<Map<string, ModelCardMeta>> {
  const result = new Map<string, ModelCardMeta>();
  try {
    const response = await client.admin<{ data?: AdminModelLite[] }>('/api/admin/models');
    for (const model of response?.data ?? []) {
      if (!model?.id) continue;
      const note = model.note?.trim() ? model.note.trim() : null;
      const releasedAt = model.released_at ?? null;
      if (!note && !releasedAt) continue;
      result.set(model.id, { note, releasedAt });
    }
  } catch {
    // 管理端不可用时静默降级，集市仍能靠公开目录正常展示
  }
  return result;
}

export type ProviderFactor = {
  effective: number;
  expiresAt: string | null;
  startsAt: string | null;
};

export type ModelPrice = {
  /** 时段倍率（1 表示没有时段概念或当前不在窗口内） */
  factor: number;
  scheduleLabel: string | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  cacheReadPerMillion: number | null;
  imagePrice: number | null;
  providerFactor: ProviderFactor | null;
};

function scale(value: number | null | undefined, ...factors: number[]): number | null {
  if (value === null || value === undefined) return null;
  const total = factors.reduce((acc, item) => acc * item, 1);
  return Number((value * total).toFixed(6));
}

function pickProviderFactor(model: CatalogModel): ProviderFactor | null {
  const groups = Object.values(model.discounts ?? {});
  for (const group of groups) {
    const factor = group?.provider_factor;
    if (factor && factor.active !== false && typeof factor.effective === 'number') {
      return {
        effective: factor.effective,
        expiresAt: factor.expires_at ?? null,
        startsAt: factor.starts_at ?? null,
      };
    }
  }
  return null;
}

/**
 * 当刻价 = 档位单价 × 时段倍率 × 路由侧 provider_factor。
 * 不使用 catalog 的 `input_price` / `output_price`（兼容字段，取最低档且不含倍率）。
 */
export function resolveModelPrice(model: CatalogModel, at: Date = new Date()): ModelPrice {
  const profile = model.pricing_profile ?? {};
  const current = resolveCurrentPrice(profile, at);
  const provider = pickProviderFactor(model);
  const providerFactor = provider?.effective ?? 1;

  return {
    factor: current.factor,
    scheduleLabel: current.label,
    inputPerMillion: scale(current.inputPrice, providerFactor),
    outputPerMillion: scale(current.outputPrice, providerFactor),
    cacheReadPerMillion: scale(current.cacheReadPrice, providerFactor),
    imagePrice: scale(current.imagePrice, providerFactor),
    providerFactor: provider,
  };
}

function formatDateZh(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export type PricingSummary = {
  scheduleHint: string | null;
  providerNote: string | null;
  /** 解析出的元价，展示层自行换算成算力值，避免这里再拼一套金额文案 */
  price: ModelPrice;
};

export function formatPricing(model: CatalogModel, at: Date = new Date()): PricingSummary {
  const price = resolveModelPrice(model, at);
  const provider = price.providerFactor;

  let providerNote: string | null = null;
  if (provider) {
    const percent = Math.round(provider.effective * 10 * 10) / 10;
    const expires = formatDateZh(provider.expiresAt);
    providerNote = `限时 ${percent} 折${expires ? `，至 ${expires}` : ''}`;
  }

  return {
    scheduleHint: scheduleHint(model.pricing_profile, at),
    providerNote,
    price,
  };
}

export function findModel(models: CatalogModel[], id: string): CatalogModel | null {
  return models.find((model) => model.id === id) ?? null;
}
