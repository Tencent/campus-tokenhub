import { describe, expect, it } from 'vitest';
import { applyOnboarding } from '@/lib/onboarding/apply';
import type { OnboardingPreset } from '@/lib/onboarding/types';
import { fakeClient, wrap, type GatewayCall } from '../helpers/fake-client';

const preset: OnboardingPreset = {
  version: 'test',
  generatedAt: '2026-11-09T00:00:00.000Z',
  provider: {
    id: 'tencent-tokenhub',
    name: 'Tencent TokenHub',
    kind: '__custom__',
    endpoints: { openai: { base: 'https://tokenhub.example.com/v1' } },
  },
  systemConfig: { BILLING_CURRENCY: 'CNY' },
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
  ],
};

type Store = { providers: unknown[]; models: unknown[]; routes: unknown[]; config: Map<string, string> };

function newStore(): Store {
  return { providers: [], models: [], routes: [], config: new Map() };
}

function clientFor(store: Store, failPath?: string, storedKey: string | null = 'sk-stored-key-0001') {
  return fakeClient((call: GatewayCall) => {
    const { path, request } = call;
    if (path === '/api/admin/providers/tencent-tokenhub/api-key') {
      return wrap({ api_key: storedKey ?? '' });
    }
    if (failPath && path === failPath && request?.method === 'POST') {
      return new Error('gateway exploded');
    }
    if (request?.method === 'POST' && path === '/api/admin/providers') {
      store.providers.push(request.body);
      return wrap({ id: 'tencent-tokenhub' });
    }
    if (request?.method === 'POST' && path === '/api/admin/models') {
      store.models.push(request.body);
      return wrap({ id: 'hy4' });
    }
    if (request?.method === 'POST' && path === '/api/admin/routes') {
      store.routes.push(request.body);
      return wrap({ id: 'route-1' });
    }
    if (request?.method === 'PUT' && path === '/api/admin/config') {
      const body = request.body as { key: string; value: string };
      store.config.set(body.key, body.value);
      return { success: true };
    }
    if (request?.method === 'PATCH') {
      return { success: true };
    }
    if (path === '/api/admin/config') {
      return wrap([...store.config].map(([key, value]) => ({ key, value })));
    }
    if (path === '/api/admin/providers') return wrap(store.providers);
    if (path === '/api/admin/models') return wrap(store.models);
    if (path === '/api/admin/routes') return wrap(store.routes);
    throw new Error(`未预期的请求：${path}`);
  });
}

describe('applyOnboarding', () => {
  it('全新网关：依次创建 provider、模型、路由并写入完成标记', async () => {
    const store = newStore();
    const client = clientFor(store);

    const { result } = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      preset,
      client,
    });

    expect(result?.ok).toBe(true);
    expect(result?.completed).toBe(true);
    expect(result?.created).toBe(3); // provider + model + route
    expect(result?.updated).toBe(1); // BILLING_CURRENCY
    expect(store.providers).toHaveLength(1);
    expect(store.models).toHaveLength(1);

    const providerBody = store.providers[0] as { api_key: string; endpoints: unknown };
    expect(providerBody.api_key).toBe('sk-school-1234567890');
    expect(providerBody.endpoints).toEqual({ openai: { base: 'https://tokenhub.example.com/v1' } });

    const routeBody = store.routes[0] as { provider_model_name: string; model_id: string; weight: number };
    expect(routeBody.model_id).toBe('hy4');
    expect(routeBody.provider_model_name).toBe('hy4');
    expect(routeBody.weight).toBe(1);

    expect(store.config.get('BILLING_CURRENCY')).toBe('CNY');
    expect(store.config.get('ONBOARDING_COMPLETED')).toMatch(/\|stu-1$/);
  });

  it('同款模型：路由带 weight，模型带加权路由策略，上游模型名单独映射', async () => {
    const sharedPreset: OnboardingPreset = {
      ...preset,
      models: preset.models.map((model) =>
        model.id === 'hy4'
          ? {
              ...model,
              routePolicy: { strategy: 'weighted_random' },
              route: { ...model.route, providerModelName: 'hy4-upstream', weight: 2 },
            }
          : model
      ),
    };
    const store = newStore();
    const client = clientFor(store);

    const { result } = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      preset: sharedPreset,
      client,
    });

    expect(result?.ok).toBe(true);
    const modelBody = store.models[0] as { route_policy: unknown };
    expect(modelBody.route_policy).toBe(JSON.stringify({ strategy: 'weighted_random' }));

    const routeBody = store.routes[0] as { provider_model_name: string; weight: number };
    expect(routeBody.provider_model_name).toBe('hy4-upstream');
    expect(routeBody.weight).toBe(2);
  });

  it('上游未收录的模型带上页面补的价格一起导入', async () => {
    const store = newStore();
    const client = clientFor(store);

    const { result } = await applyOnboarding({
      selectedModelIds: ['qwen3-max'],
      extraModels: [{ id: 'qwen3-max', inputPrice: 2, outputPrice: 8 }],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      preset,
      client,
    });

    expect(result?.ok).toBe(true);
    const model = store.models[0] as {
      id: string;
      vendor: string;
      pricing_profile: { tiers: { input_price: number; output_price: number }[] };
    };
    expect(model.id).toBe('qwen3-max');
    expect(model.vendor).toBe('aliyun');
    expect(model.pricing_profile.tiers[0]).toMatchObject({ input_price: 2, output_price: 8 });

    const route = store.routes[0] as { model_id: string; provider_model_name: string };
    expect(route.model_id).toBe('qwen3-max');
    expect(route.provider_model_name).toBe('qwen3-max');
  });

  it('dryRun 只返回计划，不写任何东西', async () => {
    const store = newStore();
    const client = clientFor(store);

    const outcome = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      dryRun: true,
      preset,
      client,
    });

    expect(outcome.result).toBeNull();
    expect(outcome.plan.summary.create).toBe(3);
    expect(outcome.plan.summary.update).toBe(1);
    expect(store.providers).toHaveLength(0);
    expect(store.config.size).toBe(0);
  });

  it('不填 Key 时复用网关里已保存的 Key：provider 走跳过', async () => {
    const store = newStore();
    store.providers.push({
      id: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      kind: '__custom__',
      endpoints: { openai: { base: 'https://tokenhub.example.com/v1' } },
      api_key: 'sk-…0001',
    });
    const client = clientFor(store);

    const { result } = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: null,
      forceOverwrite: false,
      subject: 'stu-1',
      preset,
      client,
    });

    expect(result?.ok).toBe(true);
    // 只有原有供应商，没有新建
    expect(store.providers).toHaveLength(1);
    const plan = result?.steps.find((step) => step.group === 'provider');
    expect(plan).toMatchObject({ action: 'skip', ok: true });
    expect(client.calls.some((call) => call.path === '/api/admin/providers/tencent-tokenhub/api-key')).toBe(true);
    expect(store.config.get('ONBOARDING_COMPLETED')).toMatch(/\|stu-1$/);
  });

  it('复用旧 Key 但网关里没有存过密钥时直接报错，不写完成标记', async () => {
    const store = newStore();
    store.providers.push({
      id: 'tencent-tokenhub',
      name: 'Tencent TokenHub',
      kind: '__custom__',
      endpoints: { openai: { base: 'https://tokenhub.example.com/v1' } },
      api_key: '(empty)',
    });
    const client = clientFor(store, undefined, null);

    await expect(
      applyOnboarding({
        selectedModelIds: ['hy4'],
        apiKey: null,
        forceOverwrite: false,
        subject: 'stu-1',
        preset,
        client,
      })
    ).rejects.toThrow('网关里没有可复用的 Key');

    expect(store.config.has('ONBOARDING_COMPLETED')).toBe(false);
  });

  it('中途失败不写完成标记，重试时已成功项跳过', async () => {
    const store = newStore();
    const failing = clientFor(store, '/api/admin/models');

    const first = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      preset,
      client: failing,
    });

    expect(first.result?.ok).toBe(false);
    expect(first.result?.completed).toBe(false);
    expect(store.config.has('ONBOARDING_COMPLETED')).toBe(false);

    // 模型创建失败后，路由也会失败（没有模型可挂），但 provider 已建成
    expect(store.providers).toHaveLength(1);

    // 第二次换一个不失败的客户端：按现状重算，provider 走更新、模型与路由补齐
    const retry = clientFor(store);
    const second = await applyOnboarding({
      selectedModelIds: ['hy4'],
      apiKey: 'sk-school-1234567890',
      forceOverwrite: false,
      subject: 'stu-1',
      preset,
      client: retry,
    });

    expect(second.result?.ok).toBe(true);
    expect(second.result?.completed).toBe(true);
    expect(store.config.get('ONBOARDING_COMPLETED')).toMatch(/\|stu-1$/);
  });
});
