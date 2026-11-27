/**
 * 模型目录价格 → 网关 `pricing_profile` 的适配层。
 *
 * 价格数据全部来自 `model-catalog.ts`（腾讯云官方文档快照），这里不再维护第二份价目表。
 * 网关只能表达 token 阶梯价与按张价；视频 / 3D / 音乐 / 语音等计费方式返回 null，
 * 由调用方标注「网关暂不支持」，而不是要求管理员手填价格。
 */

import type { OnboardingPricingProfile } from './types';
import {
  MODEL_CATALOG_SOURCE,
  MODEL_CATALOG_VERSION,
  getCatalogEntry,
  isCatalogImportable,
  type ModelCatalogEntry,
} from './model-catalog';

/** @deprecated 直接用 `MODEL_CATALOG_VERSION`；保留别名兼容旧引用。 */
export const PRICE_CATALOG_VERSION = MODEL_CATALOG_VERSION;
/** @deprecated 直接用 `MODEL_CATALOG_SOURCE`；保留别名兼容旧引用。 */
export const PRICE_CATALOG_SOURCE = MODEL_CATALOG_SOURCE;

export type CatalogTier = {
  upto: number | null;
  label?: string | null;
  input: number;
  output: number;
  cacheRead?: number;
};

/** 能落到网关的目录价视图（token 或按张）。 */
export type CatalogPrice = {
  /** 元 / 百万 tokens */
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  tiers?: CatalogTier[];
  schedule?: NonNullable<OnboardingPricingProfile['schedule']>;
  /** 元 / 张（图片生成） */
  image?: number;
  note?: string;
};

export type ResolvedExtraPrice = {
  inputPrice: number;
  outputPrice: number;
  imagePrice: number | null;
  cacheRead: number | null;
  /** 完整计费配置：目录价保留阶梯与峰谷，手填价只落单档 */
  pricingProfile: OnboardingPricingProfile;
};

/** 目录里的 token / 按张价；视频等网关表达不了的计费方式返回 null。 */
export function getCatalogPrice(id: string): CatalogPrice | null {
  const entry = getCatalogEntry(id);
  if (!entry) return null;
  const pricing = entry.pricing;
  if (pricing.mode === 'per_image') {
    return { image: pricing.price, ...(pricing.note ? { note: pricing.note } : {}) };
  }
  if (pricing.mode !== 'token') return null;
  return {
    input: pricing.input,
    output: pricing.output,
    ...(pricing.cacheRead === undefined ? {} : { cacheRead: pricing.cacheRead }),
    ...(pricing.cacheWrite === undefined ? {} : { cacheWrite: pricing.cacheWrite }),
    ...(pricing.tiers
      ? {
          tiers: pricing.tiers.map((tier) => ({
            upto: tier.upto,
            label: tier.label,
            input: tier.input,
            output: tier.output,
            ...(tier.cacheRead === undefined ? {} : { cacheRead: tier.cacheRead }),
          })),
        }
      : {}),
    ...(pricing.schedule ? { schedule: pricing.schedule } : {}),
    ...(pricing.note ? { note: pricing.note } : {}),
  };
}

function catalogTiers(price: CatalogPrice): OnboardingPricingProfile['tiers'] {
  if (price.tiers?.length) {
    return price.tiers.map((tier) => ({
      upto: tier.upto,
      label: tier.label ?? null,
      input_price: tier.input,
      output_price: tier.output,
      ...(tier.cacheRead === undefined ? {} : { cache_read_price: tier.cacheRead }),
      ...(price.cacheWrite === undefined ? {} : { cache_write_price: price.cacheWrite }),
    }));
  }
  if (price.input === undefined) return undefined;
  return [
    {
      upto: null,
      label: null,
      input_price: price.input,
      output_price: price.output ?? 0,
      ...(price.cacheRead === undefined ? {} : { cache_read_price: price.cacheRead }),
      ...(price.cacheWrite === undefined ? {} : { cache_write_price: price.cacheWrite }),
    },
  ];
}

/** 目录价 → 网关 pricing_profile（按张优先，其次 token 阶梯）。 */
export function catalogPricingProfile(price: CatalogPrice): OnboardingPricingProfile {
  if (price.image !== undefined) {
    return { image_billing_mode: 'per_image', image: { default: price.image } };
  }
  return {
    tiers: catalogTiers(price),
    ...(price.schedule ? { schedule: price.schedule } : {}),
  };
}

/** 目录条目 → 网关 pricing_profile；不可导入的计费方式返回 null。 */
export function catalogEntryPricingProfile(entry: ModelCatalogEntry): OnboardingPricingProfile | null {
  const price = getCatalogPrice(entry.id);
  return price ? catalogPricingProfile(price) : null;
}

function singleTierProfile(inputPrice: number, outputPrice: number, cacheRead: number | null): OnboardingPricingProfile {
  return {
    tiers: [
      {
        upto: null,
        label: null,
        input_price: inputPrice,
        output_price: outputPrice,
        ...(cacheRead === null ? {} : { cache_read_price: cacheRead }),
      },
    ],
  };
}

function fromCatalog(entry: ModelCatalogEntry): ResolvedExtraPrice | null {
  if (!isCatalogImportable(entry)) return null;
  const pricingProfile = catalogEntryPricingProfile(entry);
  if (!pricingProfile) return null;
  const price = getCatalogPrice(entry.id);
  return {
    inputPrice: price?.input ?? 0,
    outputPrice: price?.output ?? 0,
    imagePrice: price?.image ?? null,
    cacheRead: price?.cacheRead ?? null,
    pricingProfile,
  };
}

/**
 * 「未收录模型」的最终价格：管理员显式填的正数优先，否则直接用静态目录价。
 *
 * 目录里没有该模型、或该模型的计费方式网关表达不了（视频 / 3D / 音乐 / 语音）时返回 null，
 * 由 `validate.ts` 给出具体原因，不再要求手填价格。
 */
export function resolveExtraPrice(
  id: string,
  inputPrice?: unknown,
  outputPrice?: unknown,
  imagePrice?: unknown
): ResolvedExtraPrice | null {
  const typedInput = Number(inputPrice);
  const typedOutput = Number(outputPrice);
  const typedImage = Number(imagePrice);

  if (Number.isFinite(typedImage) && typedImage > 0) {
    return {
      inputPrice: 0,
      outputPrice: 0,
      imagePrice: typedImage,
      cacheRead: null,
      pricingProfile: { image_billing_mode: 'per_image', image: { default: typedImage } },
    };
  }
  if (Number.isFinite(typedInput) && typedInput > 0) {
    const output = Number.isFinite(typedOutput) && typedOutput > 0 ? typedOutput : 0;
    // 管理员没改价（与目录价一致）时直接用目录配置，保留阶梯与峰谷；改过就只按他填的算
    const catalog = getCatalogPrice(id);
    const sameAsCatalog = catalog?.input === typedInput && (catalog.output ?? 0) === output;
    if (sameAsCatalog) {
      const entry = getCatalogEntry(id);
      const fromCatalogPrice = entry ? fromCatalog(entry) : null;
      if (fromCatalogPrice) return fromCatalogPrice;
    }
    return {
      inputPrice: typedInput,
      outputPrice: output,
      imagePrice: null,
      cacheRead: null,
      pricingProfile: singleTierProfile(typedInput, output, null),
    };
  }

  const entry = getCatalogEntry(id);
  return entry ? fromCatalog(entry) : null;
}
