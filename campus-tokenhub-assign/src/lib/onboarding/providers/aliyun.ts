/**
 * 阿里云百炼（Model Studio）热门模型清单。
 *
 * 数据来源（官方文档，2026-11-19 核对）：
 * - 模型广场 / 文本生成：https://help.aliyun.com/zh/model-studio/text-generation-model
 * - 模型大全：https://help.aliyun.com/zh/model-studio/models
 * - 向量模型：https://help.aliyun.com/zh/model-studio/embedding-rerank-model
 * - 价格：https://help.aliyun.com/zh/model-studio/model-pricing
 *
 * 只收录当前主推的旗舰 / 均衡 / 高性价比文本模型 + 文本向量模型。
 * **不含图像生成**：百炼文生图走 DashScope 原生
 * `/api/v1/services/aigc/multimodal-generation/generation`，与网关的 OpenAI
 * `images.generations` 协议不兼容，硬接会在运行时失败。
 */

import type { OnboardingPreset } from '../types';
import { DEEPSEEK_PEAK_SCHEDULE } from '../model-catalog';
import { applySharedRouting, SHARED_ROUTE_WEIGHTS } from '../shared-routing';
import { chatModel, embeddingModel } from './build';

export const ALIYUN_PRESET_VERSION = 'aliyun-2026-11-19';

const ALIYUN_PRESET_BASE: OnboardingPreset = {
  version: ALIYUN_PRESET_VERSION,
  generatedAt: '2026-11-19T00:00:00.000Z',
  provider: {
    id: 'aliyun-bailian',
    name: '阿里云百炼',
    kind: '__custom__',
    // 北京地域的 OpenAI 兼容入口；旧域名 dashscope.aliyuncs.com 仍然可用
    endpoints: { openai: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } },
  },
  systemConfig: {
    BILLING_CURRENCY: 'CNY',
    BUSINESS_TIMEZONE: 'Asia/Shanghai',
  },
  models: [
    chatModel({
      id: 'qwen4-max',
      name: 'Qwen4-Max',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 10, output: 30 }],
    }),
    chatModel({
      id: 'qwen3.8-max',
      name: 'Qwen3.8-Max',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 12, output: 36, cacheRead: 1.5 }],
    }),
    chatModel({
      id: 'qwen3.7-max',
      name: 'Qwen3.7-Max',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 12, output: 36, cacheRead: 2.4 }],
    }),
    chatModel({
      id: 'qwen3.7-plus',
      name: 'Qwen3.7-Plus',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [
        { upto: 256_000, label: '0-256K', input: 2, output: 8, cacheRead: 0.4 },
        { upto: null, label: '256K-1M', input: 6, output: 24, cacheRead: 1.2 },
      ],
    }),
    chatModel({
      id: 'qwen3.8-flash',
      name: 'Qwen3.8-Flash',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [{ upto: null, input: 0.8, output: 2.7, cacheRead: 0.1 }],
    }),
    chatModel({
      id: 'qwen3.7-flash',
      name: 'Qwen3.7-Flash',
      vendor: 'aliyun',
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      inputModalities: ['text', 'image', 'video'],
      tiers: [
        { upto: 32_000, label: '0-32K', input: 0.2, output: 0.8, cacheRead: 0.04 },
        { upto: 256_000, label: '32K-256K', input: 0.6, output: 2.4, cacheRead: 0.12 },
        { upto: null, label: '256K-1M', input: 1.2, output: 4.8, cacheRead: 0.24 },
      ],
    }),
    // 以下三个模型与腾讯云 / 火山同款，共用同一个网关模型 id（见 shared-routing.ts）
    chatModel({
      id: 'deepseek-v4.1-flash-1017',
      name: 'DeepSeek-V4.1-Flash-1017',
      vendor: 'deepseek',
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      inputModalities: ['text', 'image'],
      tiers: [{ upto: null, label: '高峰时段', input: 2, output: 8, cacheRead: 0.04 }],
      schedule: DEEPSEEK_PEAK_SCHEDULE,
    }),
    chatModel({
      id: 'kimi-k3.1-pro',
      name: 'Kimi K3.1 Pro',
      vendor: 'moonshot',
      contextWindow: 1_048_576,
      maxTokens: 1_048_576,
      inputModalities: ['text', 'image'],
      tiers: [{ upto: null, input: 13, output: 68, cacheRead: 1.3 }],
    }),
    chatModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      vendor: 'zhipu',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      inputModalities: ['text'],
      tiers: [{ upto: null, input: 8, output: 28, cacheRead: 2 }],
    }),
    embeddingModel({
      id: 'qwen3.7-text-embedding',
      name: 'Qwen3.7-Text-Embedding',
      vendor: 'aliyun',
      contextWindow: 131_072,
      price: 0.5,
    }),
    embeddingModel({
      id: 'text-embedding-v4',
      name: 'Text-Embedding-V4',
      vendor: 'aliyun',
      contextWindow: 8_192,
      price: 0.5,
    }),
  ],
};

export const ALIYUN_PRESET = applySharedRouting(ALIYUN_PRESET_BASE, SHARED_ROUTE_WEIGHTS.aliyun);

/** 默认勾选：旗舰 + 均衡 + 性价比各留一个，外加一个向量模型与三款跨厂商同款模型。 */
export const ALIYUN_FEATURED_IDS: string[] = [
  'qwen4-max',
  'qwen3.8-max',
  'qwen3.7-plus',
  'qwen3.8-flash',
  'deepseek-v4.1-flash-1017',
  'kimi-k3.1-pro',
  'glm-5.3',
  'qwen3.7-text-embedding',
];

/** 学校创建 / 复制百炼 API Key 的控制台地址。 */
export const ALIYUN_API_KEY_URL = 'https://bailian.console.aliyun.com/?apiKey=1&tab=app#/api-key';
