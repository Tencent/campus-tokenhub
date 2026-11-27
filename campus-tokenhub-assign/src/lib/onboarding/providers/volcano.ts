/**
 * 火山方舟（Volcengine Ark）热门模型清单。
 *
 * 数据来源（官方文档，2026-11-19 核对）：
 * - 模型列表：https://www.volcengine.com/docs/82379/1330310
 * - 模型价格：https://docs.volcengine.com/docs/82379/1544106
 * - 图片生成：https://www.volcengine.com/docs/ark/seedream-5-0-pro
 * - 向量模型：https://www.volcengine.com/docs/ark/embedding
 *
 * 只收录主推的豆包 Seed 系列 + 方舟托管的第三方热门模型 + Seedream 图像。
 * 视频（Seedance）按秒计费，网关没有对应 operation，暂不收录。
 * 向量（doubao-embedding-vision）只提供 `/embeddings/multimodal`，请求/响应都不是 OpenAI
 * `/embeddings` 形状，网关无法直连，也暂不收录。
 */

import type { OnboardingPreset } from '../types';
import { DEEPSEEK_PEAK_SCHEDULE } from '../model-catalog';
import { applySharedRouting, SHARED_ROUTE_WEIGHTS } from '../shared-routing';
import { chatModel, imageModel } from './build';

export const VOLCANO_PRESET_VERSION = 'volcano-2026-11-19';

const VOLCANO_PRESET_BASE: OnboardingPreset = {
  version: VOLCANO_PRESET_VERSION,
  generatedAt: '2026-11-19T00:00:00.000Z',
  provider: {
    id: 'volcano-ark',
    name: '火山方舟',
    kind: '__custom__',
    // 方舟的 OpenAI 兼容入口（北京地域）；其它地域把 cn-beijing 换掉即可
    endpoints: { openai: { base: 'https://ark.cn-beijing.volces.com/api/v3' } },
  },
  systemConfig: {
    BILLING_CURRENCY: 'CNY',
    BUSINESS_TIMEZONE: 'Asia/Shanghai',
  },
  models: [
    chatModel({
      id: 'doubao-seed-2-1-pro-260915',
      name: 'Doubao-Seed-2.1-Pro',
      vendor: 'bytedance',
      contextWindow: 1_024_000,
      maxTokens: 256_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 6, output: 30, cacheRead: 1.2 }],
    }),
    chatModel({
      id: 'doubao-seed-2-1-turbo-260628',
      name: 'Doubao-Seed-2.1-Turbo',
      vendor: 'bytedance',
      contextWindow: 256_000,
      maxTokens: 256_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 3, output: 15, cacheRead: 0.6 }],
    }),
    chatModel({
      id: 'doubao-seed-2-1-lite-260915',
      name: 'Doubao-Seed-2.1-Lite',
      vendor: 'bytedance',
      contextWindow: 1_024_000,
      maxTokens: 256_000,
      inputModalities: ['text', 'image', 'video', 'audio'],
      tiers: [{ upto: null, input: 0.8, output: 2.7, cacheRead: 0.16 }],
    }),
    chatModel({
      id: 'doubao-seed-evolving',
      name: 'Doubao-Seed-Evolving',
      vendor: 'bytedance',
      contextWindow: 1_024_000,
      maxTokens: 256_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 6, output: 30, cacheRead: 1.2 }],
    }),
    chatModel({
      id: 'doubao-seed-2-0-lite-260428',
      name: 'Doubao-Seed-2.0-Lite（LTS）',
      vendor: 'bytedance',
      contextWindow: 256_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image', 'video', 'audio'],
      tiers: [
        { upto: 32_000, label: '0-32K', input: 0.6, output: 3.6, cacheRead: 0.12 },
        { upto: 128_000, label: '32K-128K', input: 0.9, output: 5.4, cacheRead: 0.18 },
        { upto: null, label: '128K-256K', input: 1.8, output: 10.8, cacheRead: 0.36 },
      ],
    }),
    // 以下三个模型与腾讯云 / 阿里云同款，共用同一个网关模型 id（见 shared-routing.ts）
    chatModel({
      id: 'deepseek-v4.1-flash-1017',
      providerModelName: 'deepseek-v4-1-flash-261017',
      name: 'DeepSeek-V4.1-Flash-1017',
      vendor: 'deepseek',
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      inputModalities: ['text', 'image', 'video'],
      // 方舟分高峰 / 空闲计价；这里保守按高峰价落单档，避免低谷价把成本算少
      tiers: [{ upto: null, label: '高峰时段', input: 2, output: 8, cacheRead: 0.04 }],
      schedule: DEEPSEEK_PEAK_SCHEDULE,
    }),
    chatModel({
      id: 'glm-5.3-flash',
      providerModelName: 'glm-5-3-flash-260828',
      name: 'GLM-5.3 Flash',
      vendor: 'zhipu',
      contextWindow: 1_048_576,
      maxTokens: 128_000,
      inputModalities: ['text', 'image'],
      tiers: [{ upto: null, input: 0.8, output: 2.8, cacheRead: 0.23 }],
    }),
    chatModel({
      id: 'kimi-k3.1-pro',
      providerModelName: 'kimi-k3-1-pro-261024',
      name: 'Kimi K3.1 Pro',
      vendor: 'moonshot',
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      inputModalities: ['text', 'image'],
      tiers: [{ upto: null, input: 13, output: 68, cacheRead: 1.3 }],
    }),
    imageModel({
      id: 'doubao-seedream-5-0-pro-260628',
      name: 'Doubao-Seedream-5.0-Pro',
      vendor: 'bytedance',
      // ≤1.5K 为 0.30 元/张，1.5K 以上 0.60；网关按单一价计费，先落低档价
      price: 0.3,
      recommended: false,
    }),
    imageModel({
      id: 'doubao-seedream-5-0-flash-260915',
      name: 'Doubao-Seedream-5.0-Flash',
      vendor: 'bytedance',
      price: 0.12,
    }),
    imageModel({
      id: 'doubao-seedream-4-0-20260415',
      name: 'Doubao-Seedream-4.0',
      vendor: 'bytedance',
      price: 0.2,
      recommended: false,
    }),
  ],
};

export const VOLCANO_PRESET = applySharedRouting(VOLCANO_PRESET_BASE, SHARED_ROUTE_WEIGHTS.volcano);

/** 默认勾选：豆包主力三档 + LTS + DeepSeek/Kimi/GLM-Flash 同款加权池 + 图像各一个。 */
export const VOLCANO_FEATURED_IDS: string[] = [
  'doubao-seed-2-1-pro-260915',
  'doubao-seed-2-1-turbo-260628',
  'doubao-seed-2-1-lite-260915',
  'doubao-seed-2-0-lite-260428',
  'deepseek-v4.1-flash-1017',
  'kimi-k3.1-pro',
  'glm-5.3-flash',
  'doubao-seedream-5-0-flash-260915',
];

/** 学校创建 / 复制方舟 API Key 的控制台地址。 */
export const VOLCANO_API_KEY_URL = 'https://console.volcengine.com/ark/region:cn-beijing/apiKey';
