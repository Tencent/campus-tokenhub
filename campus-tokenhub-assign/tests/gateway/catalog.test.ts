import { beforeEach, describe, expect, it } from 'vitest';
import { GatewayError } from '@/lib/gateway/client';
import {
  CATALOG_TTL_MS,
  formatPricing,
  getCatalog,
  listChatModels,
  resetCatalogCache,
  resolveModelPrice,
} from '@/lib/gateway/catalog';
import type { CatalogModel } from '@/lib/gateway/types';
import { fakeClient, type GatewayCall } from '../helpers/fake-client';

/** DeepSeek：工作日峰谷，空闲 0.5 */
const schedule = [
  { start: '00:00', end: '09:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '12:00', end: '14:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '18:00', end: '24:00', factor: 0.5, days: [1, 2, 3, 4, 5] },
  { start: '00:00', end: '24:00', factor: 0.5, days: [6, 7] },
];

const deepseek: CatalogModel = {
  id: 'deepseek/deepseek-flash',
  display_name: 'DeepSeek-V4.1-Flash',
  vendor: 'tencent',
  context_window: 1_000_000,
  max_tokens: 384_000,
  input_modalities: ['text'],
  output_modalities: ['text'],
  inbound: [{ protocol: 'openai', operation: 'chat' }],
  route_groups: ['default'],
  tags: [],
  pricing_profile: {
    tiers: [{ input_price: 2, output_price: 8, cache_read_price: 0.04 }],
    schedule,
  },
  discounts: { default: { kind: 'schedule', provider_factor: null } },
};

/** hy4：无时段，路由侧限时 5 折，2026-12-31 到期 */
const hy4: CatalogModel = {
  ...deepseek,
  id: 'hy4',
  display_name: 'hy4',
  pricing_profile: { tiers: [{ input_price: 4, output_price: 16 }] },
  discounts: {
    default: {
      kind: 'flat',
      provider_factor: {
        base: 0.5,
        effective: 0.5,
        active: true,
        starts_at: '2026-11-05T00:00:00.000Z',
        expires_at: '2026-12-31T15:59:59.000Z',
      },
    },
  },
};

const thursdayNight = new Date('2026-11-05T22:00:00+08:00');
const thursdayNoon = new Date('2026-11-05T10:00:00+08:00');

beforeEach(() => {
  resetCatalogCache();
});

describe('getCatalog 缓存', () => {
  it('首次打网关，TTL 内命中缓存', async () => {
    const client = fakeClient(() => ({ data: [deepseek] }));

    const first = await getCatalog(client, 1_000);
    const second = await getCatalog(client, 1_000 + CATALOG_TTL_MS - 1);

    expect(first.models).toHaveLength(1);
    expect(second.models).toHaveLength(1);
    expect(second.stale).toBe(false);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]).toMatchObject({ channel: 'public', path: '/catalog/models' });
  });

  it('TTL 过期后重新拉取', async () => {
    const client = fakeClient(() => ({ data: [deepseek] }));

    await getCatalog(client, 1_000);
    await getCatalog(client, 1_000 + CATALOG_TTL_MS + 1);

    expect(client.calls).toHaveLength(2);
  });

  it('拉取失败但有旧缓存时返回旧值并标记 stale', async () => {
    let fail = false;
    const client = fakeClient(() => (fail ? new GatewayError('down', 502) : { data: [deepseek] }));

    await getCatalog(client, 1_000);
    fail = true;
    const snapshot = await getCatalog(client, 1_000 + CATALOG_TTL_MS + 1);

    expect(snapshot.stale).toBe(true);
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.fetchedAt).toBe(1_000);
  });

  it('无缓存且失败时抛错', async () => {
    const client = fakeClient(() => new GatewayError('down', 502));

    await expect(getCatalog(client, 1_000)).rejects.toBeInstanceOf(GatewayError);
  });

  it('兼容裸数组与 {data:[]} 两种外壳', async () => {
    const client = fakeClient(() => [deepseek]);

    await expect(getCatalog(client, 1_000)).resolves.toMatchObject({ models: [deepseek] });
  });
});

describe('listChatModels（管理端视角）', () => {
  const adminModels = [
    {
      id: 'deepseek-v4.1-flash-1017',
      display_name: 'DeepSeek-V4.1-Flash-1017',
      input_modalities: ['text', 'image'],
      output_modalities: JSON.stringify(['text']),
    },
    { id: 'glm-5.3', display_name: null, input_modalities: '["text"]', output_modalities: ['text'] },
    { id: 'hy3', display_name: 'Hy3' },
    { id: 'kling-image-v3', display_name: 'Kling-Image-v3', output_modalities: ['image'] },
  ];

  function handlerWith(routes: unknown[]) {
    return (call: GatewayCall) =>
      call.path === '/api/admin/models' ? { data: adminModels } : { data: routes };
  }

  it('只返回有 active chat 路由的模型，且完全不读公开目录', async () => {
    const client = fakeClient(
      handlerWith([
        {
          model_id: 'deepseek-v4.1-flash-1017',
          status: 'active',
          surfaces: JSON.stringify([
            { request_protocol: 'openai', request_operation: 'chat', status: 'active' },
          ]),
        },
        { model_id: 'glm-5.3', status: 'active', upstream_operation: 'chat' },
        { model_id: 'hy3', status: 'disabled', upstream_operation: 'chat' },
        {
          model_id: 'kling-image-v3',
          status: 'active',
          surfaces: JSON.stringify([
            { request_protocol: 'openai', request_operation: 'images.generations', status: 'active' },
          ]),
        },
      ])
    );

    const list = await listChatModels(client);

    expect(list).toEqual([
      {
        id: 'deepseek-v4.1-flash-1017',
        name: 'DeepSeek-V4.1-Flash-1017',
        inputModalities: ['text', 'image'],
        // 管理端把模态存成 TEXT，字符串也要能读出来
        outputModalities: ['text'],
      },
      { id: 'glm-5.3', name: 'glm-5.3', inputModalities: ['text'], outputModalities: ['text'] },
    ]);
    expect(client.calls.every((call) => call.channel === 'admin')).toBe(true);
  });

  it('全操作通配 * 也算对话路由', async () => {
    const client = fakeClient(
      handlerWith([
        {
          model_id: 'glm-5.3',
          status: 'active',
          surfaces: [{ request_protocol: 'openai', request_operation: '*' }],
        },
      ])
    );

    expect(await listChatModels(client)).toEqual([
      { id: 'glm-5.3', name: 'glm-5.3', inputModalities: ['text'], outputModalities: ['text'] },
    ]);
  });

  it('管理端报错时把异常抛给调用方去退回公开目录', async () => {
    const client = fakeClient(() => new GatewayError('down', 502));

    await expect(listChatModels(client)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('resolveModelPrice', () => {
  it('空闲时段按 ×0.5', () => {
    const price = resolveModelPrice(deepseek, thursdayNight);

    expect(price.factor).toBe(0.5);
    expect(price.scheduleLabel).toBe('空闲时段');
    expect(price.inputPerMillion).toBe(1);
    expect(price.outputPerMillion).toBe(4);
  });

  it('高峰时段按原价', () => {
    const price = resolveModelPrice(deepseek, thursdayNoon);

    expect(price.factor).toBe(1);
    expect(price.inputPerMillion).toBe(2);
    expect(price.outputPerMillion).toBe(8);
  });

  it('叠加路由侧 provider_factor', () => {
    const price = resolveModelPrice(hy4, thursdayNoon);

    expect(price.providerFactor).toMatchObject({ effective: 0.5 });
    expect(price.inputPerMillion).toBe(2);
    expect(price.outputPerMillion).toBe(8);
  });

  it('图片按张计价', () => {
    const image: CatalogModel = {
      ...deepseek,
      pricing_profile: { image_billing_mode: 'per_image', image: { default: 0.15 } },
    };

    expect(resolveModelPrice(image, thursdayNoon).imagePrice).toBe(0.15);
  });

  it('没有价格配置时全部为 null，不抛错', () => {
    const price = resolveModelPrice({ ...deepseek, pricing_profile: null }, thursdayNoon);

    expect(price.inputPerMillion).toBeNull();
    expect(price.imagePrice).toBeNull();
  });
});

describe('formatPricing', () => {
  it('给页面用的汇总里带时段提示与限时折扣说明', () => {
    const summary = formatPricing(hy4, thursdayNoon);

    // 展示层的金额文案已交给算力值换算，这里只保证元价原样透出
    expect(summary.price.inputPerMillion).toBe(2);
    expect(summary.price.outputPerMillion).toBe(8);
    expect(summary.providerNote).toContain('5 折');
    expect(summary.providerNote).toContain('2026');
    expect(summary.scheduleHint).toBeNull();
  });

  it('有峰谷时给出时段说明', () => {
    expect(formatPricing(deepseek, thursdayNight).scheduleHint).toContain('空闲');
  });
});
