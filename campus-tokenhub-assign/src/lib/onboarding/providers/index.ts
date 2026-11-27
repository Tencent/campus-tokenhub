/**
 * 初始化支持的供应商注册表。
 *
 * 三个供应商的接入方式一致（OpenAI 兼容 + Bearer Key），差异只有：
 * - provider id / 名称 / Base URL
 * - 推荐模型清单（各自只接热门模型）
 * - 完成标记在网关 `system_config` 里的键（按供应商分别记录）
 * - 是否挂静态模型目录（只有腾讯云有 150+ 模型的官方目录快照）
 *
 * 门户不落盘任何供应商状态，全部从网关实时读。
 */

import { CURRENT_PRESET, FEATURED_MODEL_IDS, TOKENHUB_API_KEY_URL } from '../preset';
import type { OnboardingPreset } from '../types';
import { ALIYUN_API_KEY_URL, ALIYUN_FEATURED_IDS, ALIYUN_PRESET } from './aliyun';
import { VOLCANO_API_KEY_URL, VOLCANO_FEATURED_IDS, VOLCANO_PRESET } from './volcano';

export const PROVIDER_KEYS = ['tencent', 'aliyun', 'volcano'] as const;
export type ProviderKey = (typeof PROVIDER_KEYS)[number];

/**
 * 清单外模型的补价来源：
 * - `tencent`：可按腾讯云官方模型目录补参数与价格（`model-catalog.ts`）
 * - `none`：只接清单内热门模型，上游多出来的模型不展示、不可导入
 */
export type ModelCatalogScope = 'tencent' | 'none';

export type OnboardingProvider = {
  key: ProviderKey;
  /** 标签页上的短名 */
  label: string;
  /** 一句话定位，页面标题下方使用 */
  tagline: string;
  /** 上游控制台创建 Key 的地址 */
  apiKeyUrl: string;
  /** Key 输入框标签 */
  keyLabel: string;
  /** 「还没有 Key？…」链接文案 */
  keyLinkLabel: string;
  preset: OnboardingPreset;
  /** 默认勾选的主流模型 */
  featuredIds: string[];
  /** 该供应商的完成标记键（`system_config`） */
  completionKey: string;
  catalogScope: ModelCatalogScope;
  /** 模型参数 / 价格的来源说明，向导第二步展示 */
  priceSourceLabel: string;
};

export const PROVIDERS: Record<ProviderKey, OnboardingProvider> = {
  tencent: {
    key: 'tencent',
    label: '腾讯云',
    tagline: '腾讯云 TokenHub',
    apiKeyUrl: TOKENHUB_API_KEY_URL,
    keyLabel: 'TokenHub API Key',
    keyLinkLabel: '去腾讯云创建',
    preset: CURRENT_PRESET,
    featuredIds: FEATURED_MODEL_IDS,
    // 沿用旧键，已上线的实例升级后仍被识别为「腾讯云已完成」
    completionKey: 'ONBOARDING_COMPLETED',
    catalogScope: 'tencent',
    priceSourceLabel: '腾讯云官方模型目录',
  },
  aliyun: {
    key: 'aliyun',
    label: '阿里云',
    tagline: '阿里云百炼',
    apiKeyUrl: ALIYUN_API_KEY_URL,
    keyLabel: '百炼 API Key',
    keyLinkLabel: '去阿里云百炼创建',
    preset: ALIYUN_PRESET,
    featuredIds: ALIYUN_FEATURED_IDS,
    completionKey: 'ONBOARDING_COMPLETED_ALIYUN',
    catalogScope: 'none',
    priceSourceLabel: '阿里云百炼官方文档',
  },
  volcano: {
    key: 'volcano',
    label: '火山引擎',
    tagline: '火山方舟',
    apiKeyUrl: VOLCANO_API_KEY_URL,
    keyLabel: '方舟 API Key',
    keyLinkLabel: '去火山引擎创建',
    preset: VOLCANO_PRESET,
    featuredIds: VOLCANO_FEATURED_IDS,
    completionKey: 'ONBOARDING_COMPLETED_VOLCANO',
    catalogScope: 'none',
    priceSourceLabel: '火山方舟官方文档',
  },
};

export const PROVIDER_LIST: OnboardingProvider[] = PROVIDER_KEYS.map((key) => PROVIDERS[key]);

export const DEFAULT_PROVIDER_KEY: ProviderKey = 'tencent';

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === 'string' && (PROVIDER_KEYS as readonly string[]).includes(value);
}

/** 解析供应商参数：空值回落到腾讯云（兼容旧客户端 / 旧书签），非法值返回 null。 */
export function parseProviderKey(raw: unknown): ProviderKey | null {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PROVIDER_KEY;
  return isProviderKey(raw) ? raw : null;
}

export function getProvider(key: ProviderKey): OnboardingProvider {
  return PROVIDERS[key];
}

/** 由 preset 里的 provider id 反查供应商（路由/状态层没有 URL 参数时用）。 */
export function providerByPresetId(providerId: string): OnboardingProvider | null {
  return PROVIDER_LIST.find((provider) => provider.preset.provider.id === providerId) ?? null;
}

/** 只保留清单里存在的 featured 模型。 */
export function defaultSelectedIds(key: ProviderKey): string[] {
  const provider = PROVIDERS[key];
  const available = new Set(provider.preset.models.map((model) => model.id));
  return provider.featuredIds.filter((id) => available.has(id));
}
