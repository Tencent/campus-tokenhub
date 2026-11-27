/**
 * 腾讯云 TokenHub 模型目录（静态配置）：模型参数 + 官方价格。
 *
 * 数据来源（腾讯云官方文档，最近核对 2026-11-09）：
 * - 模型列表（上下文 / 最大输入输出 / 能力）：https://cloud.tencent.com/document/product/1823/130051
 * - 模型价格（token / 按张 / 按秒 / 按积分）：https://cloud.tencent.com/document/product/1823/130055
 *
 * 这份文件是**唯一**的模型元数据来源：初始化向导直接读取，不再在页面上手填价格。
 * 官方调价或上下架后，只改这个文件（改完把 MODEL_CATALOG_VERSION 一起更新），
 * 不要运行时抓取——文档页是前端渲染，抓取不稳定。
 *
 * 价格口径：
 * - `token`：元 / 百万 tokens，input/output/cacheRead/cacheWrite；DeepSeek 原厂直供写高峰价，
 *   `schedule` 在空闲时段打 5 折（与网关 preset 的写法一致）。
 * - `per_image`：元 / 张。
 * - `per_second`：元 / 秒（视频、ASR、配音）。
 * - `per_call`：元 / 次、元 / 个、元 / 首、元 / 万字符、元 / 音色。
 * - `per_credit`：积分计费，`creditPrice` 为 1 积分对应的人民币价格。
 * - `none`：文档未给价或模型已下线。
 *
 * 只有 `token` 与 `per_image` 能落成网关的 `pricing_profile`；
 * 视频 / 3D / 音乐 / 语音等计费方式网关表达不了，只展示、不可导入。
 */

import type { OnboardingPricingProfile } from './types';
import type { ModelCategoryKey } from './model-category';
import { formatPointsPrice, formatPointsUnitPrice } from '@/lib/portal/points';

/** 文档版本（模型列表 / 价格页的「最近更新」日期） */
export const MODEL_CATALOG_VERSION = '2026-11-17';
/** 本文件最后一次人工核对日期（2026-11-27 复核「能力支持」列的深度思考标注） */
export const MODEL_CATALOG_UPDATED_AT = '2026-11-27';
export const MODEL_CATALOG_SOURCE = 'https://cloud.tencent.com/document/product/1823/130055';
export const MODEL_CATALOG_SOURCES = [
  'https://cloud.tencent.com/document/product/1823/130051',
  'https://cloud.tencent.com/document/product/1823/130055',
] as const;

export type CatalogSchedule = NonNullable<OnboardingPricingProfile['schedule']>;

export type CatalogTier = {
  /** 输入 token 上界；末档为 null */
  upto: number | null;
  label: string;
  input: number;
  output: number;
  cacheRead?: number;
};

export type CatalogPricing =
  | {
      mode: 'token';
      /** 元 / 百万 tokens */
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      tiers?: CatalogTier[];
      schedule?: CatalogSchedule;
      note?: string;
    }
  | { mode: 'per_image'; /** 元 / 张 */ price: number; note?: string }
  | { mode: 'per_second'; /** 元 / 秒 */ min: number; max: number; note?: string }
  | {
      mode: 'per_call';
      min: number;
      max: number;
      unit: '次' | '个' | '首' | '万字符' | '音色';
      note?: string;
    }
  | { mode: 'per_credit'; /** 1 积分对应的人民币价格 */ creditPrice: number; note: string }
  | { mode: 'none'; note: string };

export type CatalogModelStatus = 'online' | 'pre-offline' | 'offline';

export type ModelCatalogEntry = {
  id: string;
  name: string;
  vendor: string;
  category: ModelCategoryKey;
  contextWindow?: number;
  maxInput?: number;
  maxOutput?: number;
  input: string[];
  output: string[];
  pricing: CatalogPricing;
  /** 缺省为 online；pre-offline 表示官方已公告下线日期 */
  status?: CatalogModelStatus;
  /** 下线时间、活动价、后付费等补充说明 */
  note?: string;
};

/** DeepSeek 原厂直供的峰谷价：北京时间工作日 9:00–12:00、14:00–18:00 为高峰，其余时段 5 折。 */
export const DEEPSEEK_PEAK_SCHEDULE: CatalogSchedule = [
  { start: '00:00', end: '09:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '12:00', end: '14:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '18:00', end: '24:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '00:00', end: '24:00', factor: 0.5, days: [6, 7] },
];

/** 模型 id → 目录条目；键为网关里的模型 id（与上游 `/v1/models` 一致）。 */
const CATALOG: Record<string, Omit<ModelCatalogEntry, 'id'>> = {
  // ---------------------------------------------------------------- 对话 / 多模态理解（按 token 计价）
  'deepseek-v4-flash-202605': { name: 'DeepSeek-V4-Flash 0731 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-v4-flash': { name: 'DeepSeek-V4-Flash 0731 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-v4-flash-0731': { name: 'DeepSeek-V4-Flash 0731 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-v4-flash-vision-exp': { name: 'DeepSeek-V4-Flash-Vision-Exp', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek-v4-pro': { name: 'DeepSeek-V4-Pro', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 12, output: 24, cacheRead: 1 } },
  'deepseek-v4-pro-0813': { name: 'DeepSeek-V4-Pro 0813 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 9, output: 27, cacheRead: 0.3, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 4.5/13.5 元/百万 tokens，表内为高峰价' } },
  'deepseek-v4-pro-202606': { name: 'DeepSeek-V4-Pro 0813 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 9, output: 27, cacheRead: 0.3, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 4.5/13.5 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-v4-pro': { name: 'DeepSeek-V4-Pro 0813 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 9, output: 27, cacheRead: 0.3, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 4.5/13.5 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-v4-pro-0813': { name: 'DeepSeek-V4-Pro 0813 正式版', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 9, output: 27, cacheRead: 0.3, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 4.5/13.5 元/百万 tokens，表内为高峰价' } },
  'deepseek-v4.1-flash': { name: 'DeepSeek-V4.1-Flash', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek-v4.1-flash-1017': { name: 'DeepSeek-V4.1-Flash-1017', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'deepseek/deepseek-flash': { name: 'DeepSeek-V4.1-Flash-1017', vendor: 'deepseek', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 384000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 2, output: 8, cacheRead: 0.04, schedule: DEEPSEEK_PEAK_SCHEDULE, note: '官方峰谷价：空闲时段 1/4 元/百万 tokens，表内为高峰价' } },
  'glm-5.2': { name: 'GLM-5.2', vendor: 'zhipu', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 8, output: 28, cacheRead: 2 } },
  'glm-5.3': { name: 'GLM-5.3', vendor: 'zhipu', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 8, output: 28, cacheRead: 2 } },
  'glm-5.3-flash': { name: 'GLM-5.3-Flash', vendor: 'zhipu', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text', 'image', 'video', 'file'], output: ['text'], pricing: { mode: 'token', input: 0.8, output: 2.8, cacheRead: 0.23 } },
  'glm-5.3-flashx': { name: 'GLM-5.3-FlashX', vendor: 'zhipu', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text', 'image', 'video', 'file'], output: ['text'], pricing: { mode: 'token', input: 2, output: 7, cacheRead: 0.57 } },
  'glm-5v-turbo': { name: 'GLM-5V-Turbo', vendor: 'zhipu', category: 'chat', contextWindow: 200000, maxInput: 200000, maxOutput: 128000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 5, output: 22, cacheRead: 1.2, tiers: [{ upto: 32768, label: '输入长度（0, 32k]', input: 5, output: 22, cacheRead: 1.2 }, { upto: null, label: '输入长度 32k+', input: 7, output: 26, cacheRead: 1.8 }] }, status: 'offline', note: '已于 2026-10-30 下线' },
  'hy-mt2-lite': { name: 'Hy-MT2-Lite', vendor: 'tencent', category: 'chat', contextWindow: 8000, maxInput: 4000, maxOutput: 4000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 0.3, output: 1.2 } },
  'hy-mt2-plus': { name: 'Hy-MT2-Plus', vendor: 'tencent', category: 'chat', contextWindow: 8000, maxInput: 4000, maxOutput: 4000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 0.5, output: 2 } },
  'hy-mt2-pro': { name: 'Hy-MT2-Pro', vendor: 'tencent', category: 'chat', contextWindow: 8000, maxInput: 4000, maxOutput: 4000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 0.5, output: 2 } },
  'hy-role': { name: 'Hy-Role', vendor: 'tencent', category: 'chat', contextWindow: 32000, maxInput: 28000, maxOutput: 4000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 2.4, output: 9.6 } },
  'hunyuan-role-latest': { name: 'Hy-Role-Latest', vendor: 'tencent', category: 'chat', contextWindow: 32000, maxInput: 28000, maxOutput: 4000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 2.4, output: 9.6 } },
  'hunyuan-t1-vision-20250916': { name: 'HY-Vision-1.5-Thinking', vendor: 'tencent', category: 'chat', contextWindow: 40000, maxInput: 16000, maxOutput: 24000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 3, output: 9 } },
  'hy-vision-2.0-instruct': { name: 'HY-Vision-2.0-Instruct', vendor: 'tencent', category: 'chat', contextWindow: 44000, maxInput: 24000, maxOutput: 16000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 7.5, output: 17.5 } },
  'hunyuan-turbos-vision-video-20250728': { name: 'HY-Vision-Video', vendor: 'tencent', category: 'chat', contextWindow: 32000, maxInput: 24000, maxOutput: 8000, input: ['text', 'video'], output: ['text'], pricing: { mode: 'token', input: 3, output: 9 } },
  'hy3': { name: 'Hy3', vendor: 'tencent', category: 'chat', contextWindow: 256000, maxInput: 192000, maxOutput: 128000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 1, output: 4, cacheRead: 0.25 } },
  'hy4': { name: 'Hy4', vendor: 'tencent', category: 'chat', contextWindow: 1024000, maxInput: 960000, maxOutput: 64000, input: ['text', 'image'], output: ['text'], pricing: { mode: 'token', input: 6, output: 18, cacheRead: 0.3 } },
  'hy4-preview': { name: 'Hy4 preview', vendor: 'tencent', category: 'chat', contextWindow: 1024000, maxInput: 960000, maxOutput: 64000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 6, output: 18, cacheRead: 0.3 } },
  'kimi-k2.7-code': { name: 'Kimi K2.7 Code', vendor: 'moonshot', category: 'chat', contextWindow: 256000, maxInput: 256000, maxOutput: 256000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 6.5, output: 27, cacheRead: 1.3 } },
  'kimi-k2.7-code-highspeed': { name: 'Kimi K2.7 Code HighSpeed', vendor: 'moonshot', category: 'chat', contextWindow: 256000, maxInput: 256000, maxOutput: 256000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 13, output: 54, cacheRead: 2.6 } },
  'kimi-k2.8-preview': { name: 'Kimi K2.8 Preview', vendor: 'moonshot', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 1024000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 6.5, output: 27, cacheRead: 1.7 } },
  'kimi-k3': { name: 'Kimi K3', vendor: 'moonshot', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 1024000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 20, output: 100, cacheRead: 2 } },
  'kimi-k3.1-pro': { name: 'Kimi K3.1 Pro', vendor: 'moonshot', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 1024000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 13, output: 68, cacheRead: 1.3, cacheWrite: 13 } },
  'kimi-k3.1-pro-highspeed': { name: 'Kimi K3.1 Pro HighSpeed', vendor: 'moonshot', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 1024000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 26, output: 136, cacheRead: 1.3, cacheWrite: 26 } },
  'kimi-k2.6': { name: 'Kimi-K2.6', vendor: 'moonshot', category: 'chat', contextWindow: 256000, maxInput: 256000, maxOutput: 256000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 6.5, output: 27, cacheRead: 1.1 } },
  'mimo-v2.5-pro': { name: 'MiMo-V2.5-Pro', vendor: 'xiaomi', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 3, output: 6, cacheRead: 0.025 } },
  'mimo-v2.6-flash': { name: 'MiMo-V2.6-Flash', vendor: 'xiaomi', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 1, output: 2, cacheRead: 0.02 } },
  'mimo-v2.6-pro': { name: 'MiMo-V2.6-Pro', vendor: 'xiaomi', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 128000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 3, output: 6, cacheRead: 0.025 } },
  'minimax-m2.7': { name: 'MiniMax-M2.7', vendor: 'minimax', category: 'chat', contextWindow: 200000, maxInput: 200000, maxOutput: 128000, input: ['text'], output: ['text'], pricing: { mode: 'token', input: 2.1, output: 8.4, cacheRead: 0.42 }, status: 'pre-offline', note: '2026-11-17 下线' },
  'minimax-m3': { name: 'MiniMax-M3', vendor: 'minimax', category: 'chat', contextWindow: 1024000, maxInput: 1024000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 2.1, output: 8.4, cacheRead: 0.42, tiers: [{ upto: 524288, label: '输入长度（0, 512k]', input: 2.1, output: 8.4, cacheRead: 0.42 }, { upto: null, label: '输入长度 512k+', input: 4.2, output: 16.8, cacheRead: 0.84 }] } },
  'minimax-m3.1-flash': { name: 'MiniMax-M3.1-Flash', vendor: 'minimax', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 512000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 1, output: 4, cacheRead: 0.1 } },
  'step-5-preview': { name: 'Step 5 Preview', vendor: 'stepfun', category: 'chat', contextWindow: 1024000, maxInput: 1024000, maxOutput: 64000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 7, output: 20, cacheRead: 0.35 } },
  'youtu-vita': { name: 'YT-VITA', vendor: 'tencent', category: 'chat', contextWindow: 128000, maxInput: 100000, maxOutput: 15000, input: ['text', 'image', 'video'], output: ['text'], pricing: { mode: 'token', input: 1.2, output: 3.5 } },

  // ---------------------------------------------------------------- 图像生成（按张计价）
  'hidream-image-o1-1.5': { name: 'HiDream-Image-o1-1.5', vendor: 'hidream', category: 'image', input: ['text'], output: ['image'], pricing: { mode: 'per_image', price: 0.6 } },
  'hidream-image-o1-1.5-edit': { name: 'HiDream-Image-o1-1.5-edit', vendor: 'hidream', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.65 } },
  'hy-image-v3': { name: 'Hy-Image-3.0', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.2 }, status: 'pre-offline', note: '2026-11-12 下线' },
  'hy-image-v3.5-preview': { name: 'Hy-Image-3.5-preview', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.15, note: '1K 0.15 元/张；2K 0.15 元/张；4K 0.2 元/张' } },
  'hy-image-lite': { name: 'HY-Image-Lite', vendor: 'tencent', category: 'image', input: ['text'], output: ['image'], pricing: { mode: 'none', note: '已于 2026-09-15 下线（原价 0.099 元/张）' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'hy-image-v3.0': { name: 'HY-Image-V3.0', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'none', note: '已于 2026-09-15 下线（原价 0.2 元/张）' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kling-image-o1': { name: 'Kling-Image-o1', vendor: 'kuaishou', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.2, note: '1K / 2K 0.2 元/张' } },
  'kling-image-v3': { name: 'Kling-Image-v3', vendor: 'kuaishou', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.2, note: '1K / 2K 0.2 元/张' } },
  'kling-image-v3-omni': { name: 'Kling-Image-v3-omni', vendor: 'kuaishou', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.2, note: '1K / 2K 0.2 元/张；4K 0.4 元/张' } },
  'seedream-image-v5.0-flash': { name: 'Seedream-Image-v5.0-flash', vendor: 'bytedance', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.12 } },
  'seedream-image-v5.0-lite': { name: 'Seedream-Image-v5.0-lite', vendor: 'bytedance', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.22 }, status: 'pre-offline', note: '2026-11-24 下线' },
  'seedream-image-v5.0-pro': { name: 'Seedream-Image-v5.0-pro', vendor: 'bytedance', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.3, note: '输出图≤261万像素 0.3 元/张；输出图>261万像素 0.6 元/张' } },
  'vidu-image-q2': { name: 'Vidu-Image-q2', vendor: 'shengshu', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.1875, note: '1080P 0.1875 元/张；2K 0.25 元/张；4K 0.3125 元/张；1080P 0.25 元/张；2K 0.375 元/张；4K 0.625 元/张' } },
  'wand-vega-image-flash': { name: 'WAND-Vega-Image-1.0-Flash', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.267, note: '1K 0.267 元/张；2K 0.374 元/张；4K 0.775 元/张' } },
  'wand-vega-image-lite': { name: 'WAND-Vega-Image-1.0-Lite', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.135, note: '1K 0.135 元/张；2K 0.135 元/张；4K 0.18 元/张' } },
  'wand-vega-image-pro': { name: 'WAND-Vega-Image-1.0-Pro', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'per_image', price: 0.95, note: '1K 0.95 元/张；2K 0.95 元/张；4K 1.71 元/张' } },
  'wand-vega-image-1.5-pro': { name: 'WAND-Vega-Image-1.5-Pro', vendor: 'tencent', category: 'image', input: ['text', 'image'], output: ['image'], pricing: { mode: 'none', note: '腾讯云文档暂未提供该模型的价格，以控制台计费为准' } },

  // ---------------------------------------------------------------- 向量（按 token 计价）
  'kinfra-text-embedding-0.6b': { name: 'Kinfra-Text-Embedding-0.6b', vendor: 'kinfra', category: 'embedding', contextWindow: 32000, input: ['text'], output: ['embedding'], pricing: { mode: 'token', input: 0.5, output: 0 }, note: '输出维度 1024' },
  'kinfra-text-embedding-4b': { name: 'Kinfra-Text-Embedding-4b', vendor: 'kinfra', category: 'embedding', contextWindow: 32000, input: ['text'], output: ['embedding'], pricing: { mode: 'token', input: 0.6, output: 0 }, note: '输出维度 2560' },
  'kinfra-vl-embedding-2b': { name: 'Kinfra-VL-Embedding-2b', vendor: 'kinfra', category: 'embedding', contextWindow: 32000, input: ['text', 'image', 'video'], output: ['embedding'], pricing: { mode: 'token', input: 0.5, output: 0, note: '图片输入 0.7 元/百万 tokens；视频输入 1.5 元/百万 tokens' }, note: '输出维度 2048' },
  'kinfra-vl-embedding-8b': { name: 'Kinfra-VL-Embedding-8b', vendor: 'kinfra', category: 'embedding', contextWindow: 32000, input: ['text', 'image', 'video'], output: ['embedding'], pricing: { mode: 'token', input: 0.6, output: 0, note: '图片输入 0.9 元/百万 tokens；视频输入 1.8 元/百万 tokens' }, note: '输出维度 4096' },

  // ---------------------------------------------------------------- 语音合成 / 识别 / 配音（网关暂不可路由）
  'hy-asr-3.0-preview': { name: 'Hy-ASR-3.0-Preview', vendor: 'tencent', category: 'audio', input: ['audio'], output: ['text'], pricing: { mode: 'per_second', min: 0.00022, max: 0.00022, note: '0.00022 元/秒（22 tokens/秒）' } },
  'indextts-2': { name: 'IndexTTS-2', vendor: 'other', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 3, max: 3, unit: '万字符', note: '3 元/每万字符（300,000 tokens/每万字符）' } },
  'minimax-speech-02-hd': { name: 'MiniMax-Speech-02-HD', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 3.5, max: 3.5, unit: '万字符', note: '3.5 元/每万字符（350,000 tokens/每万字符）' } },
  'minimax-speech-02-turbo': { name: 'MiniMax-Speech-02-Turbo', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 2, max: 2, unit: '万字符', note: '2 元/每万字符（200,000 tokens/每万字符）' } },
  'minimax-speech-2.6-hd': { name: 'MiniMax-Speech-2.6-HD', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 3.5, max: 3.5, unit: '万字符', note: '3.5 元/每万字符（350,000 tokens/每万字符）' } },
  'minimax-speech-2.6-turbo': { name: 'MiniMax-Speech-2.6-Turbo', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 2, max: 2, unit: '万字符', note: '2 元/每万字符（200,000 tokens/每万字符）' } },
  'minimax-speech-2.8-hd': { name: 'MiniMax-Speech-2.8-HD', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 3.5, max: 3.5, unit: '万字符', note: '3.5 元/每万字符（350,000 tokens/每万字符）' } },
  'minimax-speech-2.8-turbo': { name: 'MiniMax-Speech-2.8-Turbo', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 2, max: 2, unit: '万字符', note: '2 元/每万字符（200,000 tokens/每万字符）' } },
  'minimax-voice-clone': { name: 'MiniMax-Voice-Clone', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 9.9, max: 9.9, unit: '音色', note: '9.9 元/音色（990,000 tokens/音色）' } },
  'minimax-voice-design': { name: 'MiniMax-Voice-Design', vendor: 'minimax', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 9.9, max: 9.9, unit: '音色', note: '9.9 元/音色（990,000 tokens/音色）' } },
  'tenlai-asr-v1.0': { name: 'Tenlai-ASR-v1', vendor: 'tencent', category: 'audio', input: ['audio'], output: ['text'], pricing: { mode: 'per_second', min: 0.00022, max: 0.00022, note: '0.00022 元/秒（22 tokens/秒）' } },
  'tenlai-tts-v1.0': { name: 'Tenlai-TTS-v1', vendor: 'tencent', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 2.5, max: 2.5, unit: '万字符', note: '2.5 元/每万字符（250,000 tokens/每万字符）' } },
  'wand-asr-v1': { name: 'WAND-ASR-v1', vendor: 'tencent', category: 'audio', input: ['audio'], output: ['text'], pricing: { mode: 'per_second', min: 0.0005, max: 0.0005, note: '0.0005 元/秒（50 tokens/秒）' } },
  'wand-dubbing-clone-v1': { name: 'WAND-Dubbing-Clone-v1', vendor: 'tencent', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_second', min: 0.1228, max: 0.1228, note: '0.1228 元/秒（12,280 tokens/秒）' } },
  'wand-dubbing-clone-v2': { name: 'WAND-Dubbing-Clone-v2', vendor: 'tencent', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_second', min: 0.2061, max: 0.2061, note: '0.2061 元/秒（20,610 tokens/秒）' } },
  'wand-dubbing-sts-v1': { name: 'WAND-Dubbing-STS-v1', vendor: 'tencent', category: 'audio', input: ['text'], output: ['audio'], pricing: { mode: 'per_second', min: 0.008333333, max: 0.008333333, note: '0.008333333 元/秒（834 tokens/秒）' } },

  // ---------------------------------------------------------------- 音乐生成（网关暂不可路由）
  'minimax-music-v2.6': { name: 'MiniMax-Music-v2.6', vendor: 'minimax', category: 'music', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 1, max: 1, unit: '首', note: '1 元/首（100,000 tokens/首）' } },
  'minimax-music-v3.0': { name: 'MiniMax-Music-v3.0', vendor: 'minimax', category: 'music', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 1, max: 1, unit: '首', note: '100,000 tokens/首' } },
  'mureka-music-v9': { name: 'Mureka-Music-v9', vendor: 'mureka', category: 'music', input: ['text'], output: ['audio'], pricing: { mode: 'per_call', min: 0.33, max: 0.33, unit: '首', note: '0.33 元/首（33000 tokens/首）' } },

  // ---------------------------------------------------------------- 视频生成（网关暂不可路由）
  'hy-video-1.5': { name: 'HY-Video-1.5', vendor: 'tencent', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.3, max: 0.3, note: '文 / 图生视频 / 720P 0.3 元/秒' } },
  'kling-video-motion-control-v2.6': { name: 'Kling-Video-motion-control-v2.6', vendor: 'kuaishou', category: 'video', input: ['text'], output: ['video'], pricing: { mode: 'per_second', min: 0.5, max: 0.8, note: '动作控制 / 720P 0.5 元/秒；1080P 0.8 元/秒' } },
  'kling-video-motion-control-v3.0': { name: 'Kling-Video-motion-control-v3.0', vendor: 'kuaishou', category: 'video', input: ['text'], output: ['video'], pricing: { mode: 'per_second', min: 0.9, max: 1.2, note: '动作控制 / 720P 0.9 元/秒；1080P 1.2 元/秒' } },
  'kling-video-o1': { name: 'Kling-Video-O1', vendor: 'kuaishou', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.6, max: 1.2, note: '无参考视频 / 720P 0.6 元/秒；无参考视频 / 1080P 0.8 元/秒；有参考视频 / 720P 0.9 元/秒；有参考视频 / 1080P 1.2 元/秒' } },
  'kl-video-v1': { name: 'Kling-Video-v1', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v1-5': { name: 'Kling-Video-v1.5', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v1-6': { name: 'Kling-Video-v1.6', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v2-master': { name: 'Kling-Video-v2-master', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v2-1': { name: 'Kling-Video-v2.1', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v2-1-master': { name: 'Kling-Video-v2.1-master', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kl-video-v2-5-turbo': { name: 'Kling-Video-v2.5-turbo', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kling-video-v2.5-turbo': { name: 'Kling-Video-V2.5-turbo', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.3, max: 0.5, note: '无声 / 720P 0.3 元/秒；无声 / 1080P 0.5 元/秒' } },
  'kl-video-v2-6': { name: 'Kling-Video-v2.6', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kling-video-v2.6': { name: 'Kling-Video-V2.6', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.3, max: 1.2, note: '动作控制 / 720P 0.5 元/秒；动作控制 / 1080P 0.8 元/秒；有声 - 有指定音色 / 1080P 1.2 元/秒；有声 - 未指定音色 / 1080P 1 元/秒；无声 / 720P 0.3 元/秒；无声 / 1080P 0.5 元/秒' } },
  'kl-video-v3': { name: 'Kling-Video-v3', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'kling-video-v3': { name: 'Kling-Video-V3', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.6, max: 3, note: '有声 - 未指定音色 / 720P 0.9 元/秒；有声 - 未指定音色 / 1080P 1.2 元/秒；有声 - 未指定音色 / 4K 3 元/秒；无声 / 720P 0.6 元/秒；无声 / 1080P 0.8 元/秒；无声 / 4K 3 元/秒' } },
  'kling-video-v3-omni': { name: 'Kling-Video-V3-omni', vendor: 'kuaishou', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.6, max: 3, note: '无参考视频 - 有声 / 720P 0.8 元/秒；无参考视频 - 有声 / 1080P 1 元/秒；无参考视频 - 有声 / 4K 3 元/秒；有参考视频 - 无声 / 720P 0.9 元/秒；有参考视频 - 无声 / 1080P 1.2 元/秒；有参考视频 - 无声 / 4K 3 元/秒' } },
  'kling-video-v3-turbo': { name: 'Kling-Video-V3-turbo', vendor: 'kuaishou', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.8, max: 1, note: '有声 / 720P 0.8 元/秒；有声 / 1080P 1 元/秒' } },
  'kling-video-v4': { name: 'Kling-Video-v4', vendor: 'kuaishou', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.6, max: 1.5, note: '无参考视频 / 720P 1 元/秒；无参考视频 / 1080P 1.5 元/秒；有参考视频 / 720P 0.6 元/秒；有参考视频 / 1080P 0.9 元/秒' } },
  'kling-video-v4-flash': { name: 'Kling-Video-v4-flash', vendor: 'kuaishou', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.6, max: 1, note: '无参考视频 / 720P 1 元/秒；有参考视频 / 720P 0.6 元/秒' } },
  'minimax-video-h3': { name: 'MiniMax-Video-H3', vendor: 'minimax', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.5, max: 0.8, note: '文 / 图生视频、参考生视频 / 768P 0.5 元/秒；2K 0.8 元/秒' } },
  'minimax-video-h3-max': { name: 'MiniMax-Video-H3-Max', vendor: 'minimax', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.33, max: 0.5, note: '文 / 图生视频 / 480P 0.33 元/秒；768P 0.5 元/秒' } },
  'minimax-video-v2.3': { name: 'MiniMax-Video-v2.3', vendor: 'minimax', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.333333, max: 0.583333, note: '文 / 图生视频 6s / 768P 0.333333 元/秒；文 / 图生视频 6s / 1080P 0.583333 元/秒；文 / 图生视频 10s / 768P 0.4 元/秒' } },
  'minimax-video-v2.3-fast': { name: 'MiniMax-Video-v2.3-fast', vendor: 'minimax', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.225, max: 0.385, note: '图生视频 6s / 768P 0.225 元/秒；图生视频 6s / 1080P 0.385 元/秒；图生视频 10s / 768P 0.225 元/秒' } },
  'pixverse-video-c1': { name: 'PixVerse-Video-c1', vendor: 'pixverse', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.17598, max: 0.70392, note: '有声 / 360p 0.23464 元/秒；有声 / 540p 0.2933 元/秒；有声 / 720p 0.38129 元/秒；有声 / 1080p 0.70392 元/秒；无声 / 360p 0.17598 元/秒；无声 / 540p 0.23464 元/秒' } },
  'pixverse-video-v5.6': { name: 'PixVerse-Video-v5.6', vendor: 'pixverse', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.20531, max: 0.8799, note: '有声 / 360p 0.46928 元/秒；有声 / 540p 0.46928 元/秒；有声 / 720p 0.52794 元/秒；有声 / 1080p 0.8799 元/秒；无声 / 360p 0.20531 元/秒；无声 / 540p 0.20531 元/秒' } },
  'pixverse-video-v6.0': { name: 'PixVerse-Video-v6', vendor: 'pixverse', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.14665, max: 0.67459, note: '有声 / 360p 0.20531 元/秒；有声 / 540p 0.26397 元/秒；有声 / 720p 0.35196 元/秒；有声 / 1080p 0.67459 元/秒；无声 / 360p 0.14665 元/秒；无声 / 540p 0.20531 元/秒' } },
  'vd-video-q2': { name: 'Vidu-Video-q2', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vd-video-q2-pro': { name: 'Vidu-Video-q2-pro', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vd-video-q2-pro-fast': { name: 'Vidu-Video-q2-pro-fast', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vd-video-q2-turbo': { name: 'Vidu-Video-q2-turbo', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vidu-video-q2': { name: 'Vidu-Video-q2.0', vendor: 'shengshu', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0, max: 0 } },
  'vidu-video-q2-pro': { name: 'Vidu-Video-q2.0-pro', vendor: 'shengshu', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0, max: 0 } },
  'vidu-video-q2-turbo': { name: 'Vidu-Video-q2.0-turbo', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0, max: 0 } },
  'vd-video-q3-pro': { name: 'Vidu-Video-q3-pro', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vd-video-q3-turbo': { name: 'Vidu-Video-q3-turbo', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'none', note: '已下线，腾讯云不再提供该模型' }, status: 'offline', note: '已于 2026-09-15 下线' },
  'vidu-video-q3': { name: 'Vidu-Video-q3.0', vendor: 'shengshu', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.21875, max: 0.46875, note: '有参考视频 / 540P 0.21875 元/秒；有参考视频 / 720P 0.375 元/秒；有参考视频 / 1080P 0.46875 元/秒' } },
  'vidu-video-q3-pro': { name: 'Vidu-Video-q3.0-pro', vendor: 'shengshu', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_second', min: 0.28125, max: 0.75, note: '图 / 文生视频 / 540P 0.28125 元/秒；720P 0.625 元/秒；1080P 0.75 元/秒' } },
  'vidu-video-q3-turbo': { name: 'Vidu-Video-q3.0-turbo', vendor: 'shengshu', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.125, max: 0.40625, note: '有参考视频 / 540P 0.125 元/秒；有参考视频 / 720P 0.3125 元/秒；有参考视频 / 1080P 0.40625 元/秒；图 / 文生视频 - 首尾帧 / 540P 0.21875 元/秒；图 / 文生视频 - 首尾帧 / 720P 0.375 元/秒；图 / 文生视频 - 首尾帧 / 1080P 0.40625 元/秒' } },
  'vidu-video-q4-preview': { name: 'Vidu-Video-q4-preview', vendor: 'shengshu', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.28125, max: 2.4375, note: '图生 / 参考生 / 音画同出 / 540P 0.28125 元/秒；720P 0.59375 元/秒；1080P 0.75 元/秒；2K 1.1875 元/秒；4K 2.4375 元/秒' } },
  'wand-vega-video-1.0-lite': { name: 'WAND-Vega-Video-1.0-Lite', vendor: 'tencent', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'per_second', min: 0.375, max: 0.75, note: '文 / 图生视频、参考生视频 / 768P 0.375 元/秒；1080P 0.5 元/秒；2K 0.625 元/秒；4K 0.75 元/秒' } },
  'wand-vega-video-1.5-lite': { name: 'WAND-Vega-Video-1.5-Lite', vendor: 'tencent', category: 'video', input: ['text', 'image', 'video'], output: ['video'], pricing: { mode: 'none', note: '腾讯云文档暂未提供该模型的价格，以控制台计费为准' } },
  'yt-video-2.0': { name: 'YT-Video-2.0', vendor: 'tencent', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_call', min: 2, max: 5, unit: '次', note: '积分单价 1.0 元/积分；按次计算消耗。\n480p：2 积分/次\n720p/1080p：5 积分/次' } },
  'yt-video-fx': { name: 'YT-Video-FX', vendor: 'tencent', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_call', min: 0, max: 0, unit: '次', note: '积分单价 1.0 元/积分；按次计算消耗，根据模板消耗积分。\n消耗详情请参见 视频特效模板计费。' } },
  'yt-video-humanactor': { name: 'YT-Video-HumanActor', vendor: 'tencent', category: 'video', input: ['text', 'image'], output: ['video'], pricing: { mode: 'per_call', min: 1, max: 2, unit: '次', note: '积分单价 1.0 元/积分；按秒计算消耗\n720p：1 积分/秒\n1080p：2 积分/秒' } },

  // ---------------------------------------------------------------- 3D 生成（网关暂不可路由）
  'hi3d-2.1': { name: 'Hi3D-2.1', vendor: 'tencent', category: '3d', input: ['image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '1536³ 档 25~45 积分/次' } },
  'hi3d-3.0': { name: 'Hi3D-3.0', vendor: 'tencent', category: '3d', input: ['image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '2048³ 档 45~145 积分/次' } },
  'hy-3d-3.0': { name: 'HY-3D-3.0', vendor: 'tencent', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '按次计算消耗，15～60积分/次' } },
  'hy-3d-3.1': { name: 'HY-3D-3.1', vendor: 'tencent', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '按次计算消耗，15～60积分/次' } },
  'hy-3d-component': { name: 'HY-3D-Component', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '30积分/次' } },
  'hy-3d-express': { name: 'HY-3D-Express', vendor: 'tencent', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '按次计算消耗，15～25积分/次' } },
  'hy-3d-format': { name: 'HY-3D-Format', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '5积分/次' } },
  'hy-3d-motion': { name: 'HY-3D-Motion', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '10积分/次' } },
  'hy-3d-polygen-image': { name: 'HY-3d-polygen-image', vendor: 'tencent', category: '3d', input: ['image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '50积分/次' } },
  'hy-3d-polygen-mesh': { name: 'HY-3d-polygen-mesh', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '50积分/次' } },
  'hy-3d-retopology': { name: 'HY-3D-Retopology', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '50积分/次' } },
  'hy-3d-rigging': { name: 'HY-3D-Rigging', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '10积分/次' } },
  'hy-3d-texture': { name: 'HY-3D-Texture', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '30积分/次' } },
  'hy-3d-uv': { name: 'HY-3D-UV', vendor: 'tencent', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.12, note: '10积分/次' } },
  'hy-world2-panorama': { name: 'Hy-World-2.1-panorama', vendor: 'tencent', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_call', min: 5, max: 5, unit: '个', note: '文 / 图生360° 全景图，500,000 tokens/个，5 元/个' } },
  'hy-world2-scene': { name: 'Hy-World-2.1-scene', vendor: 'tencent', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_call', min: 80, max: 80, unit: '个', note: '文 / 图生3D 场景，8,000,000 tokens/个，80 元/个' } },
  'rodin-gen-3d-2.5': { name: 'Rodin-Gen-3D-2.5', vendor: 'deemos', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'none', note: '腾讯云文档未给出单独价格，按控制台实际计费为准' } },
  'tripo-3d-3.1': { name: 'Tripo-3D-3.1', vendor: 'tripo', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '按积分计费，文生 3D 10~20 积分/次、图生 3D 20~30 积分/次（视档位与附加选项）' } },
  'tripo-3d-animation': { name: 'Tripo-3D-Animation', vendor: 'tripo', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '动画重定向 10 积分/每个动画' } },
  'tripo-3d-format': { name: 'Tripo-3D-Format', vendor: 'tripo', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '格式转换 5~10 积分/次' } },
  'tripo-3d-p1': { name: 'Tripo-3D-P1', vendor: 'tripo', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '按积分计费，文生 3D 10~20 积分/次、图生 3D 20~30 积分/次（视档位与附加选项）' } },
  'tripo-3d-p2': { name: 'Tripo-3D-P2', vendor: 'tripo', category: '3d', input: ['text', 'image'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '按积分计费，文生 3D 10~20 积分/次、图生 3D 20~30 积分/次（视档位与附加选项）' } },
  'tripo-3d-rigging': { name: 'Tripo-3D-Rigging', vendor: 'tripo', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '自动绑骨 25 积分/次' } },
  'tripo-3d-rigging-check': { name: 'Tripo-3D-Rigging-Check', vendor: 'tripo', category: '3d', input: ['text'], output: ['model'], pricing: { mode: 'per_credit', creditPrice: 0.07, note: '绑骨前检查免费' } },
};

export const MODEL_CATALOG: Record<string, ModelCatalogEntry> = Object.fromEntries(
  Object.entries(CATALOG).map(([id, model]) => [id, { id, ...model }])
);

/** 上游实际 id 与文档 id 不一致时的别名（key 为上游 id，value 为目录 id）。 */
const CATALOG_ALIASES: Record<string, string> = {
  'deepseek-v4-flash-0731': 'deepseek/deepseek-v4-flash-0731',
  'hy-video-v1.5': 'hy-video-1.5',
};

export function getCatalogEntry(id: string): ModelCatalogEntry | null {
  return MODEL_CATALOG[id] ?? MODEL_CATALOG[CATALOG_ALIASES[id] ?? ''] ?? null;
}

/**
 * 支持「深度思考」（推理）的模型 id。
 *
 * 依据腾讯云 TokenHub 官方《模型列表》的「能力支持」列人工核对
 * （https://cloud.tencent.com/document/product/1823/130051，2026-11-27 更新）：
 * - 语言模型：Hy4 / Hy4 preview / Hy3（保留式思考）、DeepSeek V4 全系列、GLM-5.2 / 5.3 全系列、
 *   Kimi K2.6 / K2.7 / K2.8 / K3 系列、MiniMax M2.7 / M3 / M3.1-Flash、MiMo V2.5-Pro / V2.6、Step 5 Preview
 *   均标注「深度思考」；
 * - 多模态理解：只有 HY-Vision-1.5-Thinking（`hunyuan-t1-vision-20250916`）标注「深度思考」，
 *   官方对 HY-Vision-2.0-Instruct 写明是「快思考模型」，HY-Vision-Video 只是视频理解，都不支持；
 * - 翻译（Hy-MT2）、角色扮演（Hy-Role）的说明里没有深度思考，也不支持。
 *
 * 不在表里的模型一律按不支持处理：客户端勾上「思考模式」却拿不到 reasoning_content 比不勾更糟。
 * 官方新增模型或改能力列后，只改这张表。
 */
const REASONING_MODEL_IDS = new Set<string>([
  // DeepSeek V4 系列（原厂直供与非直供，能力列一致）
  'deepseek-v4-flash-202605',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-flash-0731',
  'deepseek/deepseek-v4-flash-vision-exp',
  'deepseek-v4-pro',
  'deepseek-v4-pro-0813',
  'deepseek-v4-pro-202606',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-pro-0813',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-1017',
  'deepseek/deepseek-flash',
  // GLM
  'glm-5.2',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.3-flashx',
  'glm-5v-turbo',
  // 混元
  'hy3',
  'hy4',
  'hy4-preview',
  'hunyuan-t1-vision-20250916',
  // Kimi
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.8-preview',
  'kimi-k3',
  'kimi-k3.1-pro',
  'kimi-k3.1-pro-highspeed',
  // MiniMax
  'minimax-m2.7',
  'minimax-m3',
  'minimax-m3.1-flash',
  // 小米 / 阶跃
  'mimo-v2.5-pro',
  'mimo-v2.6-flash',
  'mimo-v2.6-pro',
  'step-5-preview',
]);

/**
 * 目录模型是否支持深度思考；目录里没有的模型返回 false。
 *
 * 调用方拿到 false 表示「官方没有标注支持」，不是「一定不会思考」，
 * 所以客户端配置里就不勾「思考模式」，避免展示空的思考过程。
 */
export function catalogSupportsReasoning(id: string): boolean {
  const entry = getCatalogEntry(id);
  return entry ? REASONING_MODEL_IDS.has(entry.id) : false;
}


/** 网关能否导入：离线、或计费方式无法落成 pricing_profile 的模型都不行。 */
export function isCatalogImportable(entry: ModelCatalogEntry): boolean {
  if (entry.status === 'offline') return false;
  return entry.pricing.mode === 'token' || entry.pricing.mode === 'per_image';
}

/** 不可导入时给页面看的说明；可导入返回 null。 */
export function catalogUnsupportedReason(entry: ModelCatalogEntry): string | null {
  if (entry.status === 'offline') return entry.note ?? '官方已下线';
  if (isCatalogImportable(entry)) return null;
  if (entry.pricing.mode === 'none') return entry.pricing.note;
  switch (entry.category) {
    case 'video':
      return '网关暂无视频生成接口，只展示参数与价格';
    case '3d':
      return '网关暂无 3D 生成接口，只展示参数与价格';
    case 'music':
      return '网关暂无音乐生成接口，只展示参数与价格';
    case 'audio':
      return '网关暂无 OpenAI 兼容语音接口，只展示参数与价格';
    default:
      return '网关暂不支持该计费方式';
  }
}

/**
 * 一行可读价格，供列表展示；统一用门户的算力值口径。
 *
 * 刻意不拼 `pricing.note`：原始备注里写的是「x 元/张」「x 元/秒」，
 * 展示出来等于把「算力值 ↔ 金额」的换算关系暴露给用户。
 */
export function catalogPriceText(entry: ModelCatalogEntry): string {
  const p = entry.pricing;
  if (p.mode === 'token') {
    const parts = [`输入 ${formatPointsUnitPrice(p.input, 'M')}`, `输出 ${formatPointsUnitPrice(p.output, 'M')}`];
    if (p.cacheRead !== undefined) parts.push(`缓存 ${formatPointsUnitPrice(p.cacheRead, 'M')}`);
    if (p.tiers?.length) parts.push(`${p.tiers.length} 档阶梯价`);
    return parts.join(' · ');
  }
  if (p.mode === 'per_image') return formatPointsUnitPrice(p.price, '张');
  if (p.mode === 'per_second') {
    const range = p.min === p.max ? formatPointsPrice(p.min) : `${formatPointsPrice(p.min)}~${formatPointsPrice(p.max)}`;
    return `${range} 算力值/秒`;
  }
  if (p.mode === 'per_call') {
    const range = p.min === p.max ? formatPointsPrice(p.min) : `${formatPointsPrice(p.min)}~${formatPointsPrice(p.max)}`;
    return `${range} 算力值/${p.unit}`;
  }
  if (p.mode === 'per_credit') {
    return `积分计费（1 积分 ${formatPointsPrice(p.creditPrice)} 算力值）`;
  }
  return '—';
}
