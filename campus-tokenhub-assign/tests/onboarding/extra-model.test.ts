import { describe, expect, it } from 'vitest';
import { buildExtraPresetModel } from '@/lib/onboarding/extra-model';

describe('buildExtraPresetModel', () => {
  it('对话模型按 token 计价，参数取自目录并带上峰谷折扣与缓存价', () => {
    const model = buildExtraPresetModel({
      id: 'deepseek-v4-pro-0813',
      inputPrice: 9,
      outputPrice: 27,
      cacheRead: 0.3,
    });

    expect(model.displayName).toBe('DeepSeek-V4-Pro 0813 正式版');
    expect(model.contextWindow).toBe(1_024_000);
    expect(model.maxTokens).toBe(384_000);
    expect(model.pricingProfile?.tiers?.[0]).toMatchObject({ input_price: 9, output_price: 27, cache_read_price: 0.3 });
    expect(model.pricingProfile?.schedule?.length).toBeGreaterThan(0);
    expect(model.route.upstreamOperation).toBe('chat');
    expect(model.outputModalities).toEqual(['text']);
  });

  it('没填价格时直接用目录价，阶梯价完整保留', () => {
    const model = buildExtraPresetModel({ id: 'minimax-m3', inputPrice: 0, outputPrice: 0 });

    expect(model.pricingProfile?.tiers).toHaveLength(2);
    expect(model.pricingProfile?.tiers?.[0]).toMatchObject({ input_price: 2.1, output_price: 8.4 });
    expect(model.inputModalities).toEqual(['text', 'image', 'video']);
  });

  it('图片模型走按张计费与 images.generations 路由', () => {
    const model = buildExtraPresetModel({
      id: 'seedream-image-v5.0-flash',
      inputPrice: 0,
      outputPrice: 0,
      imagePrice: 0.12,
    });

    expect(model.pricingProfile).toMatchObject({
      image_billing_mode: 'per_image',
      image: { default: 0.12 },
    });
    expect(model.route.upstreamOperation).toBe('images.generations');
    expect(model.outputModalities).toEqual(['image']);
    expect(model.inputModalities).toEqual(['text', 'image']);
    expect(model.needsPostpaid).toBe(true);
  });

  it('图片模型不填价也能从目录取按张价', () => {
    const model = buildExtraPresetModel({ id: 'kling-image-o1', inputPrice: 0, outputPrice: 0 });
    expect(model.pricingProfile).toMatchObject({ image_billing_mode: 'per_image', image: { default: 0.2 } });
  });

  it('向量模型挂 embeddings 路由', () => {
    const model = buildExtraPresetModel({
      id: 'kinfra-text-embedding-0.6b',
      inputPrice: 0.5,
      outputPrice: 0,
    });

    expect(model.route.upstreamOperation).toBe('embeddings');
    expect(model.outputModalities).toEqual(['embedding']);
    expect(model.contextWindow).toBe(32_000);
  });

  it('峰谷计费模型的路由窗口与目录一致、factor=1', () => {
    const model = buildExtraPresetModel({ id: 'deepseek-v4.1-flash-1017', inputPrice: 0, outputPrice: 0 });
    const schedule = model.route.priceOverride?.schedule as {
      mode: string;
      charged: { start: string; factor: number }[];
      metered: { start: string; factor: number }[];
    };
    expect(schedule.mode).toBe('multiply');
    expect(schedule.charged).toHaveLength(4);
    expect(schedule.charged.every((slot) => slot.factor === 1)).toBe(true);
    expect(schedule.charged.map((slot) => slot.start)).toEqual(['00:00', '12:00', '18:00', '00:00']);
    expect(schedule.metered).toEqual(schedule.charged);
  });

  it('网关表达不了的计费方式直接抛错', () => {
    expect(() => buildExtraPresetModel({ id: 'kling-video-v4', inputPrice: 0, outputPrice: 0 })).toThrow();
  });
});
