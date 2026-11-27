/** 初始化接口的入参校验：只校验形状，不判断 Key 真实有效性（交给上游探测）。 */

import { ApiError } from '@/lib/api/guard';
import { CURRENT_PRESET } from './preset';
import { providerByPresetId } from './providers';
import { resolveExtraPrice } from './pricing-catalog';
import { MODEL_CATALOG_VERSION, catalogUnsupportedReason, getCatalogEntry } from './model-catalog';
import type { ExtraModelInput, OnboardingPreset } from './types';

const MODEL_ID_PATTERN = /^[A-Za-z0-9._:/-]{1,160}$/;
/** 单个模型单价上限（元/百万 tokens 或 元/张），挡掉误输入的天文数字 */
const MAX_PRICE = 1_000_000;

export function normalizeApiKey(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : '';
  if (key.length < 8 || /\s/.test(key)) {
    throw new ApiError(400, '请填写完整的 API Key', 'invalid_api_key');
  }
  return key;
}

/**
 * 上游返回、清单未收录的模型。
 *
 * 价格优先取请求里的显式值，没填就直接用 `model-catalog.ts` 的腾讯云官方目录价；
 * 目录里没有、或计费方式网关表达不了（视频/3D/音乐/语音）时报 400 并说明原因，
 * 不再要求管理员手填价格。
 * 已收录的 id 与重复 id 直接忽略，不报错。
 *
 * 只接热门模型的供应商（阿里云 / 火山）没有静态目录：清单一律忽略，
 * 避免拿腾讯云目录价给同名模型错定价。
 */
export function normalizeExtraModels(
  raw: unknown,
  preset: OnboardingPreset = CURRENT_PRESET
): ExtraModelInput[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ApiError(400, 'extraModels 必须是数组', 'invalid_extra_models');
  if (providerByPresetId(preset.provider.id)?.catalogScope === 'none') return [];

  const presetIds = new Set(preset.models.map((model) => model.id));
  const seen = new Set<string>();
  const result: ExtraModelInput[] = [];

  for (const item of raw) {
    const record = (item ?? {}) as {
      id?: unknown;
      inputPrice?: unknown;
      outputPrice?: unknown;
      imagePrice?: unknown;
    };
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || presetIds.has(id) || seen.has(id)) continue;
    if (!MODEL_ID_PATTERN.test(id)) {
      throw new ApiError(400, `模型 id 不合法：${id.slice(0, 40)}`, 'invalid_extra_models');
    }

    const typed = [record.inputPrice, record.outputPrice, record.imagePrice].map((value) => Number(value));
    if (typed.some((value) => Number.isFinite(value) && value < 0)) {
      throw new ApiError(400, `模型 ${id} 的价格不能为负数`, 'invalid_extra_models');
    }

    const price = resolveExtraPrice(id, record.inputPrice, record.outputPrice, record.imagePrice);
    if (!price) {
      const entry = getCatalogEntry(id);
      const reason = entry
        ? catalogUnsupportedReason(entry)
        : `不在腾讯云模型目录（${MODEL_CATALOG_VERSION}）中，暂不支持导入`;
      throw new ApiError(400, `模型 ${id}：${reason}`, 'invalid_extra_models');
    }
    if (
      price.inputPrice > MAX_PRICE ||
      price.outputPrice > MAX_PRICE ||
      (price.imagePrice ?? 0) > MAX_PRICE
    ) {
      throw new ApiError(400, `模型 ${id} 的价格超出合理范围`, 'invalid_extra_models');
    }

    seen.add(id);
    result.push({
      id,
      inputPrice: price.inputPrice,
      outputPrice: price.outputPrice,
      ...(price.imagePrice === null ? {} : { imagePrice: price.imagePrice }),
      ...(price.cacheRead === null ? {} : { cacheRead: price.cacheRead }),
    });
  }
  return result;
}

export function normalizeModelIds(
  raw: unknown,
  extraIds: Set<string> = new Set(),
  preset: OnboardingPreset = CURRENT_PRESET
): string[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(400, '请至少选择一个模型', 'invalid_models');
  }
  const known = new Set([...preset.models.map((model) => model.id), ...extraIds]);
  const ids = [...new Set(raw.map((item) => String(item ?? '').trim()).filter((id) => known.has(id)))];
  if (ids.length === 0) {
    throw new ApiError(400, '请至少选择一个模型', 'invalid_models');
  }
  return ids;
}
