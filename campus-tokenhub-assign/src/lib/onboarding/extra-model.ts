/**
 * 把「上游返回、但推荐清单没收录」的模型补成可导入的 preset 行。
 *
 * 参数与价格都来自 `model-catalog.ts`（腾讯云官方文档快照）：上下文、最大输出、模态不再留空，
 * 计费方式能落到网关的直接用目录价（含阶梯与峰谷），落不了的由 `validate.ts` 拒绝。
 * 图片模型走按张计价，向量模型挂 embeddings 路由，其余按 chat 处理——不能一律当对话模型写，
 * 否则图片/向量模型调用会打到错误的上游接口。
 */

import type { ExtraModelInput, OnboardingPresetModel } from './types';
import { getCatalogEntry } from './model-catalog';
import { resolveExtraPrice } from './pricing-catalog';
import { inferCategoryFromId, inferVendorFromId } from './model-category';

export function buildExtraPresetModel(input: ExtraModelInput): OnboardingPresetModel {
  const entry = getCatalogEntry(input.id);
  const category = entry?.category ?? inferCategoryFromId(input.id);
  const resolved = resolveExtraPrice(input.id, input.inputPrice, input.outputPrice, input.imagePrice);

  if (!resolved) {
    throw new Error(`模型 ${input.id} 没有可用于网关的官方价`);
  }

  const isImage = entry ? entry.category === 'image' : resolved.imagePrice !== null;
  const upstreamOperation = isImage ? 'images.generations' : category === 'embedding' ? 'embeddings' : 'chat';
  // 模型目录价带峰谷时段时，路由侧必须给出窗口完全一致、factor=1 的 schedule，
  // 否则网关报 `Route time windows must match the model catalog schedule exactly`。
  const schedule = resolved.pricingProfile.schedule;
  const priceOverride = {
    charged_factor: 1,
    metered_factor: 1,
    ...(schedule?.length
      ? {
          schedule: {
            mode: 'multiply',
            charged: schedule.map((slot) => ({ ...slot, factor: 1 })),
            metered: schedule.map((slot) => ({ ...slot, factor: 1 })),
          },
        }
      : {}),
  };

  return {
    id: input.id,
    displayName: entry?.name ?? input.id,
    vendor: entry?.vendor ?? inferVendorFromId(input.id),
    contextWindow: entry?.contextWindow ?? null,
    maxTokens: entry?.maxOutput ?? null,
    inputModalities:
      entry?.input ??
      (isImage ? ['text', 'image'] : category === 'embedding' ? ['text'] : null),
    outputModalities:
      entry?.output ??
      (isImage ? ['image'] : category === 'embedding' ? ['embedding'] : null),
    pricingProfile: resolved.pricingProfile,
    recommended: false,
    // 图片模型需要先在上游开通「在线推理-后付费」，否则一次 402 会熔断整个供应商
    needsPostpaid: isImage,
    route: {
      providerModelName: input.id,
      status: 'active',
      priority: 0,
      upstreamProtocol: 'openai',
      upstreamOperation,
      priceOverride,
    },
  };
}
