import { describe, expect, it } from 'vitest';
import { buildPlan, type GatewaySnapshot } from '@/lib/onboarding/plan';
import type { OnboardingPreset } from '@/lib/onboarding/types';

const preset: OnboardingPreset = {
  version: 'test',
  generatedAt: '2026-11-09T00:00:00.000Z',
  provider: {
    id: 'tencent-tokenhub',
    name: 'Tencent TokenHub',
    kind: '__custom__',
    endpoints: { openai: { base: 'https://tokenhub.tencentmaas.com/v1' } },
  },
  systemConfig: { BILLING_CURRENCY: 'CNY', BUSINESS_TIMEZONE: 'Asia/Shanghai' },
  models: [
    {
      id: 'hy4',
      displayName: 'Hy4',
      vendor: 'tencent',
      contextWindow: 1024000,
      maxTokens: 64000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      pricingProfile: { tiers: [{ upto: null, input_price: 6, output_price: 18 }] },
      recommended: true,
      needsPostpaid: false,
      route: {
        providerModelName: 'hy4',
        status: 'active',
        priority: 0,
        upstreamProtocol: 'openai',
        upstreamOperation: 'chat',
        priceOverride: { charged_factor: 1, metered_factor: 1 },
      },
    },
    {
      id: 'glm-5.3',
      displayName: 'GLM-5.3',
      vendor: 'zhipu',
      contextWindow: 1024000,
      maxTokens: 128000,
      inputModalities: ['text'],
      outputModalities: ['text'],
      pricingProfile: { tiers: [{ upto: null, input_price: 8, output_price: 28 }] },
      recommended: true,
      needsPostpaid: false,
      route: {
        providerModelName: 'glm-5.3',
        status: 'active',
        priority: 0,
        upstreamProtocol: 'openai',
        upstreamOperation: 'chat',
        priceOverride: { charged_factor: 1, metered_factor: 1 },
      },
    },
  ],
};

function emptySnapshot(): GatewaySnapshot {
  return { provider: null, models: new Map(), routes: new Map(), config: new Map() };
}

function seededSnapshot(): GatewaySnapshot {
  return {
    provider: {
      id: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      kind: '__custom__',
      endpoints: { openai: { base: 'https://tokenhub.tencentmaas.com/v1' } },
    },
    models: new Map([
      [
        'hy4',
        {
          id: 'hy4',
          display_name: 'Hy4',
          vendor: 'tencent',
          context_window: 1024000,
          max_tokens: 64000,
          pricing_profile: '{}',
          input_modalities: '["text"]',
          output_modalities: '["text"]',
        },
      ],
    ]),
    routes: new Map([
      [
        'hy4',
        {
          id: 'route-1',
          model_id: 'hy4',
          provider_id: 'tencent-tokenhub',
          provider_model_name: 'hy4',
          status: 'active',
          priority: 0,
          price_override: '{}',
        },
      ],
    ]),
    config: new Map([
      ['BILLING_CURRENCY', 'CNY'],
      ['BUSINESS_TIMEZONE', 'UTC'],
    ]),
  };
}

describe('buildPlan', () => {
  it('全新实例：provider、模型、路由、缺失配置全部新建', () => {
    const plan = buildPlan({
      preset,
      selectedModelIds: ['hy4', 'glm-5.3'],
      hasApiKey: true,
      forceOverwrite: false,
      snapshot: emptySnapshot(),
    });

    expect(plan.provider.action).toBe('create');
    expect(plan.models.map((item) => item.action)).toEqual(['create', 'create']);
    expect(plan.routes.map((item) => item.action)).toEqual(['create', 'create']);
    expect(plan.config.every((item) => item.action === 'update')).toBe(true);
    expect(plan.summary.create).toBe(5);
    expect(plan.summary.update).toBe(2);
  });

  it('未勾选强制覆盖：已存在的模型与路由跳过，已有配置值不动', () => {
    const plan = buildPlan({
      preset,
      selectedModelIds: ['hy4', 'glm-5.3'],
      hasApiKey: true,
      forceOverwrite: false,
      snapshot: seededSnapshot(),
    });

    expect(plan.provider.action).toBe('update');
    expect(plan.models[0].action).toBe('skip');
    expect(plan.models[1].action).toBe('create');
    expect(plan.routes[0].action).toBe('skip');
    const timezone = plan.config.find((item) => item.key === 'BUSINESS_TIMEZONE');
    expect(timezone?.action).toBe('skip');
  });

  it('勾选强制覆盖：已存在的模型、路由与配置都改为更新', () => {
    const plan = buildPlan({
      preset,
      selectedModelIds: ['hy4'],
      hasApiKey: false,
      forceOverwrite: true,
      snapshot: seededSnapshot(),
    });

    expect(plan.provider.action).toBe('skip');
    expect(plan.models[0].action).toBe('update');
    expect(plan.routes[0].action).toBe('update');
    const timezone = plan.config.find((item) => item.key === 'BUSINESS_TIMEZONE');
    expect(timezone?.action).toBe('update');
  });

  it('同款模型：未勾强制覆盖也对齐 route_policy 与路由权重', () => {
    const sharedPreset: OnboardingPreset = {
      ...preset,
      models: preset.models.map((model) =>
        model.id === 'hy4'
          ? {
              ...model,
              routePolicy: { strategy: 'weighted_random' },
              route: { ...model.route, weight: 3 },
            }
          : model
      ),
    };

    const plan = buildPlan({
      preset: sharedPreset,
      selectedModelIds: ['hy4'],
      hasApiKey: false,
      forceOverwrite: false,
      snapshot: seededSnapshot(),
    });

    expect(plan.models[0].action).toBe('update');
    expect(plan.models[0].reasons.join('；')).toContain('加权路由策略');
    expect(plan.routes[0].action).toBe('update');
    expect(plan.routes[0].reasons.join('；')).toContain('权重 1 → 3');
  });

  it('模态与官方目录不一致时也更新（只补能力口径）', () => {
    const withImage = {
      ...preset,
      models: preset.models.map((model) =>
        model.id === 'hy4' ? { ...model, inputModalities: ['text', 'image'] } : model
      ),
    };
    const plan = buildPlan({
      preset: withImage,
      selectedModelIds: ['hy4'],
      hasApiKey: false,
      forceOverwrite: false,
      snapshot: seededSnapshot(),
    });

    expect(plan.models[0].action).toBe('update');
    expect(plan.models[0].reasons.join('；')).toContain('模态');
    // 路由与配置不受模态对齐影响
    expect(plan.routes[0].action).toBe('skip');
  });

  it('复用已保存的 Key：provider 跳过并说明复用', () => {
    const plan = buildPlan({
      preset,
      selectedModelIds: ['hy4'],
      hasApiKey: false,
      forceOverwrite: false,
      snapshot: seededSnapshot(),
    });

    expect(plan.provider.action).toBe('skip');
    expect(plan.provider.reasons.join('；')).toContain('复用网关里已保存的 Key');
  });

  it('只处理勾选的模型', () => {
    const plan = buildPlan({
      preset,
      selectedModelIds: ['glm-5.3'],
      hasApiKey: true,
      forceOverwrite: false,
      snapshot: emptySnapshot(),
    });

    expect(plan.models.map((item) => item.id)).toEqual(['glm-5.3']);
    expect(plan.routes.map((item) => item.id)).toEqual(['glm-5.3']);
  });
});
