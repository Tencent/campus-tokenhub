/**
 * 当前生效的推荐模型清单。
 *
 * 数据来自 `scripts/export-tokenhub-preset.mjs`（从已对齐的网关导出），
 * 放在 `presets/` 下按日期版本化。升级清单时：导出新文件 → 在这里改一行 import。
 * **不要把密钥写进 preset**，这里只有地址、模型元数据和价格。
 */

import raw from './presets/tokenhub-2026-11-18.json';
import { DEEPSEEK_PEAK_SCHEDULE } from './model-catalog';
import { applySharedRouting, SHARED_ROUTE_WEIGHTS } from './shared-routing';
import type { OnboardingPreset, OnboardingPresetModel } from './types';

/**
 * 清单之外补登记的模型。
 *
 * 导出脚本按「网关里已有的模型」生成快照，而 TokenHub 上新出现的固定版本快照（如
 * `deepseek-v4.1-flash-1017`）还没进网关时，导出的清单里没有它——不补在这里，
 * 学校就得等下次重新导出才能选。导出结果里已经有同 id 时以导出结果为准，不会重复。
 */
const EXTRA_PRESET_MODELS: OnboardingPresetModel[] = [
  {
    id: 'deepseek-v4.1-flash-1017',
    displayName: 'DeepSeek-V4.1-Flash-1017',
    vendor: 'deepseek',
    contextWindow: 1024000,
    maxTokens: 348000,
    inputModalities: ['text', 'image'],
    outputModalities: ['text'],
    pricingProfile: {
      tiers: [{ upto: null, label: null, input_price: 2, output_price: 8, cache_read_price: 0.04 }],
      schedule: DEEPSEEK_PEAK_SCHEDULE,
    },
    recommended: true,
    needsPostpaid: false,
    route: {
      providerModelName: 'deepseek-v4.1-flash-1017',
      status: 'active',
      priority: 0,
      upstreamProtocol: 'openai',
      upstreamOperation: 'chat',
      priceOverride: {
        charged_factor: 1,
        metered_factor: 1,
        schedule: {
          mode: 'multiply',
          charged: DEEPSEEK_PEAK_SCHEDULE.map((slot) => ({ ...slot, factor: 1 })),
          metered: DEEPSEEK_PEAK_SCHEDULE.map((slot) => ({ ...slot, factor: 1 })),
        },
      },
    },
  },
];

function withExtraModels(preset: OnboardingPreset): OnboardingPreset {
  const known = new Set(preset.models.map((model) => model.id));
  const extras = EXTRA_PRESET_MODELS.filter((model) => !known.has(model.id));
  return extras.length === 0 ? preset : { ...preset, models: [...preset.models, ...extras] };
}

export const CURRENT_PRESET = applySharedRouting(
  withExtraModels(raw as unknown as OnboardingPreset),
  SHARED_ROUTE_WEIGHTS.tencent
);

export const PRESET_VERSION = CURRENT_PRESET.version;

/** 学校创建/复制 TokenHub Key 的控制台地址（需用学校自己的腾讯云账号登录）。 */
export const TOKENHUB_API_KEY_URL = 'https://console.cloud.tencent.com/tokenhub/apikey';

export function getPresetModel(id: string): OnboardingPresetModel | null {
  return CURRENT_PRESET.models.find((model) => model.id === id) ?? null;
}

/** 只保留 preset 里存在的 id，并保持 preset 的顺序。 */
export function selectPresetModels(ids: string[]): OnboardingPresetModel[] {
  const wanted = new Set(ids);
  return CURRENT_PRESET.models.filter((model) => wanted.has(model.id));
}

/**
 * 默认勾选的主流模型：每个家族只留最新的一代，避免一上来把 20 个模型全选。
 *
 * 取舍原则：同一厂商同一系列只留版本最高的那个（选了 glm-5.3 就不再选 glm-5.2），
 * 文本与多模态各留 3~4 个旗舰，图像/向量各留现有全部。其余模型仍可手动勾选。
 */
export const FEATURED_MODEL_IDS: string[] = [
  // 多模态理解（DeepSeek 用 1017 固定快照，不带后缀的别名留着手动勾选）
  'hy4',
  'deepseek-v4.1-flash-1017',
  'glm-5.3',
  'kimi-k3.1-pro',
  'glm-5.3-flash',
  'hy-vision-2.0-instruct',
  'minimax-m3',
  // 图像生成
  'seedream-image-v5.0-flash',
  'kling-image-v3',
  // 向量
  'kinfra-text-embedding-4b',
];

/** 默认勾选：只保留清单里存在的 featured 模型。 */
export function defaultSelectedModelIds(): string[] {
  const available = new Set(CURRENT_PRESET.models.map((model) => model.id));
  return FEATURED_MODEL_IDS.filter((id) => available.has(id));
}
