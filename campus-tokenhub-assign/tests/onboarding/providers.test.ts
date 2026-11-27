import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROVIDER_KEY,
  PROVIDER_LIST,
  defaultSelectedIds,
  getProvider,
  parseProviderKey,
  providerByPresetId,
} from '@/lib/onboarding/providers';
import { getProviderStates } from '@/lib/onboarding/state';
import { SHARED_MODEL_IDS, SHARED_ROUTE_WEIGHTS } from '@/lib/onboarding/shared-routing';
import { fakeClient, wrap } from '../helpers/fake-client';

describe('供应商注册表', () => {
  it('覆盖腾讯云、阿里云、火山方舟三家，且完成标记互不冲突', () => {
    expect(PROVIDER_LIST.map((provider) => provider.key)).toEqual(['tencent', 'aliyun', 'volcano']);
    const keys = PROVIDER_LIST.map((provider) => provider.completionKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('ONBOARDING_COMPLETED');
  });

  it('每个供应商的 Base URL 都是 OpenAI 兼容入口', () => {
    expect(getProvider('aliyun').preset.provider.endpoints).toEqual({
      openai: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    });
    expect(getProvider('volcano').preset.provider.endpoints).toEqual({
      openai: { base: 'https://ark.cn-beijing.volces.com/api/v3' },
    });
  });

  it('模型 id 在单个清单内唯一，featured 都存在于清单中', () => {
    for (const provider of PROVIDER_LIST) {
      const ids = provider.preset.models.map((model) => model.id);
      expect(new Set(ids).size, provider.key).toBe(ids.length);

      const available = new Set(ids);
      for (const id of provider.featuredIds) {
        expect(available.has(id), `${provider.key}:${id}`).toBe(true);
      }
      expect(defaultSelectedIds(provider.key).length).toBeGreaterThan(0);
      expect(defaultSelectedIds(provider.key).length).toBeLessThanOrEqual(provider.featuredIds.length);
    }
  });

  it('每个模型的上下文、价格与路由操作都填完整', () => {
    for (const provider of PROVIDER_LIST) {
      for (const model of provider.preset.models) {
        expect(model.route.providerModelName.length, model.id).toBeGreaterThan(0);
        expect(['chat', 'embeddings', 'images.generations']).toContain(model.route.upstreamOperation);

        if (model.route.upstreamOperation === 'images.generations') {
          expect(model.pricingProfile?.image_billing_mode).toBe('per_image');
          expect(model.pricingProfile?.image?.default).toBeGreaterThan(0);
          continue;
        }
        const tiers = model.pricingProfile?.tiers ?? [];
        expect(tiers.length, model.id).toBeGreaterThan(0);
        for (const tier of tiers) {
          expect(tier.input_price).toBeGreaterThanOrEqual(0);
          expect(tier.output_price).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('阿里云只接文本与向量：图像生成走 DashScope 原生协议，硬接会失败', () => {
    const aliyun = getProvider('aliyun');
    const operations = aliyun.preset.models.map((model) => model.route.upstreamOperation);
    expect(aliyun.preset.models).toHaveLength(11);
    expect(operations).not.toContain('images.generations');
    expect(aliyun.preset.models.some((model) => model.id === 'qwen4-max')).toBe(true);
    expect(
      aliyun.preset.models.find((model) => model.id === 'qwen4-max')?.contextWindow
    ).toBe(1_000_000);
  });

  it('火山收录豆包主力与 Seedream 图像；向量走 multimodal 接口，暂不收录', () => {
    const volcano = getProvider('volcano');
    expect(volcano.preset.models).toHaveLength(11);
    expect(volcano.preset.models.map((model) => model.route.upstreamOperation)).not.toContain('embeddings');
    const byId = new Map(volcano.preset.models.map((model) => [model.id, model]));
    expect(byId.get('doubao-seed-2-1-pro-260915')?.route.upstreamOperation).toBe('chat');
    expect(byId.get('doubao-seedream-5-0-flash-260915')?.pricingProfile?.image?.default).toBe(0.12);
  });

  it('同款模型用同一个网关 id，权重 8:1:1，各厂商真实模型名落在 providerModelName 上', () => {
    const tencent = getProvider('tencent');
    const aliyun = getProvider('aliyun');
    const volcano = getProvider('volcano');

    expect(SHARED_ROUTE_WEIGHTS).toEqual({ tencent: 8, aliyun: 1, volcano: 1 });

    for (const id of SHARED_MODEL_IDS) {
      const t = tencent.preset.models.find((model) => model.id === id);
      const a = aliyun.preset.models.find((model) => model.id === id);
      // glm-5.3-flash 阿里云没有（只有 ZHIPU/GLM-5.3-Flash 别名），其余三家都有
      expect(t, `tencent:${id}`).toBeTruthy();
      if (id !== 'glm-5.3-flash') expect(a, `aliyun:${id}`).toBeTruthy();

      for (const model of [t, a].filter(Boolean)) {
        expect(model!.routePolicy, `${id}:routePolicy`).toEqual({ strategy: 'weighted_random' });
        expect(model!.route.weight, `${id}:weight`).toBe(model === t ? 8 : 1);
      }
    }

    const volcanoDeepseek = volcano.preset.models.find((model) => model.id === 'deepseek-v4.1-flash-1017');
    expect(volcanoDeepseek?.route.providerModelName).toBe('deepseek-v4-1-flash-261017');
    expect(volcanoDeepseek?.route.weight).toBe(1);
    expect(volcano.preset.models.find((model) => model.id === 'kimi-k3.1-pro')?.route.providerModelName).toBe(
      'kimi-k3-1-pro-261024'
    );
    expect(volcano.preset.models.find((model) => model.id === 'glm-5.3-flash')?.route.providerModelName).toBe(
      'glm-5-3-flash-260828'
    );

    // 旧的分家 id 不再出现，避免同款模型被拆成两个模型
    const volcanoIds = volcano.preset.models.map((model) => model.id);
    expect(volcanoIds).not.toContain('deepseek-v4-1-flash-261017');
    expect(volcanoIds).not.toContain('kimi-k3-1-pro-261024');
    expect(volcanoIds).not.toContain('glm-5-3-flash-260828');
  });
});

describe('供应商参数解析', () => {
  it('缺省回落到腾讯云，非法值返回 null', () => {
    expect(parseProviderKey(undefined)).toBe(DEFAULT_PROVIDER_KEY);
    expect(parseProviderKey('')).toBe(DEFAULT_PROVIDER_KEY);
    expect(parseProviderKey('aliyun')).toBe('aliyun');
    expect(parseProviderKey('openai')).toBeNull();
  });

  it('能由 preset 的 provider id 反查供应商', () => {
    expect(providerByPresetId('aliyun-bailian')?.key).toBe('aliyun');
    expect(providerByPresetId('volcano-ark')?.key).toBe('volcano');
    expect(providerByPresetId('unknown')).toBeNull();
  });
});

describe('按供应商读初始化状态', () => {
  it('阿里云完成标记只影响阿里云，不影响腾讯云', async () => {
    const client = fakeClient(({ path }) => {
      if (path === '/api/admin/config') {
        return wrap([
          { key: 'ONBOARDING_OWNER', value: '7:1' },
          { key: 'ONBOARDING_COMPLETED_ALIYUN', value: '2026-11-19T00:00:00.000Z|7:1' },
        ]);
      }
      if (path === '/api/admin/providers') {
        return wrap([{ id: 'aliyun-bailian', name: '阿里云百炼', api_key: 'sk-…abcd' }]);
      }
      if (path === '/api/admin/models') return wrap([{ id: 'qwen4-max' }]);
      if (path === '/api/admin/routes') return wrap([{ id: 'route-1', model_id: 'qwen4-max' }]);
      throw new Error(`未预期的请求：${path}`);
    });

    const states = await getProviderStates(client);
    const aliyun = states.find((item) => item.provider.key === 'aliyun')!.state;
    const tencent = states.find((item) => item.provider.key === 'tencent')!.state;

    expect(aliyun.completed).toBe(true);
    expect(aliyun.providerExists).toBe(true);
    expect(aliyun.modelCount).toBe(1);
    expect(aliyun.routeCount).toBe(1);
    expect(tencent.completed).toBe(false);
    expect(tencent.providerExists).toBe(false);
  });
});
