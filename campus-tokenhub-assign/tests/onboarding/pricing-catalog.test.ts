import { describe, expect, it } from 'vitest';
import {
  PRICE_CATALOG_SOURCE,
  PRICE_CATALOG_VERSION,
  catalogPricingProfile,
  getCatalogPrice,
  resolveExtraPrice,
} from '@/lib/onboarding/pricing-catalog';
import {
  MODEL_CATALOG,
  catalogPriceText,
  catalogUnsupportedReason,
  getCatalogEntry,
} from '@/lib/onboarding/model-catalog';

describe('静态模型目录', () => {
  it('带版本与官方来源', () => {
    expect(PRICE_CATALOG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRICE_CATALOG_SOURCE).toContain('cloud.tencent.com');
  });

  it('文本模型按 token 价，图片模型按张，视频模型不产出网关价', () => {
    expect(getCatalogPrice('glm-5.3')).toMatchObject({ input: 8, output: 28, cacheRead: 2 });
    expect(getCatalogPrice('seedream-image-v5.0-flash')).toMatchObject({ image: 0.12 });
    expect(getCatalogPrice('kling-video-v4')).toBeNull();
  });

  it('未收录模型也能从目录读到参数，不再依赖页面填写', () => {
    expect(getCatalogEntry('deepseek/deepseek-v4-flash-vision-exp')).toMatchObject({
      category: 'chat',
      contextWindow: 1_024_000,
      maxInput: 1_024_000,
      maxOutput: 384_000,
      input: ['text', 'image'],
    });
    expect(getCatalogEntry('kling-image-v3')).toMatchObject({ category: 'image' });
  });

  it('视频 / 3D / 音乐模型展示价格但不允许导入', () => {
    const video = getCatalogEntry('kling-video-v4')!;
    expect(catalogPriceText(video)).toContain('/秒');
    expect(catalogUnsupportedReason(video)).toContain('网关暂无视频生成接口');

    const world = getCatalogEntry('hy-world2-scene')!;
    expect(catalogUnsupportedReason(world)).toContain('网关暂无 3D 生成接口');

    const music = getCatalogEntry('minimax-music-v2.6')!;
    expect(catalogPriceText(music)).toContain('/首');
    expect(catalogUnsupportedReason(music)).toContain('网关暂无音乐生成接口');
  });

  it('价格文案统一成算力值，不出现金额或换算说明', () => {
    const token = getCatalogEntry('glm-5.3')!;
    expect(catalogPriceText(token)).toContain('输入 800 算力值/M');
    expect(catalogPriceText(token)).toContain('输出 2,800 算力值/M');
    expect(catalogPriceText(token)).not.toContain('¥');
    expect(catalogPriceText(token)).not.toContain('元');

    // 单价很小（元）时按 100 算力值 = 1 元放大，不需要小数
    const image = getCatalogEntry('seedream-image-v5.0-flash')!;
    expect(catalogPriceText(image)).toContain('12 算力值/张');
    // 备注里的「0.12 元/张」之类不能出现在展示文案里
    expect(catalogPriceText(image)).not.toContain('元');

    for (const entry of Object.values(MODEL_CATALOG)) {
      expect(catalogPriceText(entry)).not.toContain('元');
      expect(catalogPriceText(entry)).not.toContain('¥');
    }
  });

  it('目录覆盖腾讯云文档里的全部模型 id', () => {
    expect(Object.keys(MODEL_CATALOG).length).toBeGreaterThanOrEqual(140);
    for (const entry of Object.values(MODEL_CATALOG)) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.input.length).toBeGreaterThan(0);
      expect(entry.output.length).toBeGreaterThan(0);
    }
  });
});

describe('catalogPricingProfile', () => {
  it('普通文本模型生成单档 token 价', () => {
    expect(catalogPricingProfile(getCatalogPrice('glm-5.3')!)).toEqual({
      tiers: [{ upto: null, label: null, input_price: 8, output_price: 28, cache_read_price: 2 }],
    });
  });

  it('分段计价模型保留阶梯', () => {
    const profile = catalogPricingProfile(getCatalogPrice('minimax-m3')!);
    expect(profile.tiers).toEqual([
      { upto: 524_288, label: '输入长度（0, 512k]', input_price: 2.1, output_price: 8.4, cache_read_price: 0.42 },
      { upto: null, label: '输入长度 512k+', input_price: 4.2, output_price: 16.8, cache_read_price: 0.84 },
    ]);
  });

  it('缓存写入价只有 5 分钟档', () => {
    const profile = catalogPricingProfile(getCatalogPrice('kimi-k3.1-pro')!);
    expect(profile.tiers?.[0]).toMatchObject({ input_price: 13, output_price: 68, cache_write_price: 13 });
  });

  it('DeepSeek 峰谷价带 5 折时段', () => {
    const profile = catalogPricingProfile(getCatalogPrice('deepseek-v4-pro-0813')!);
    expect(profile.tiers?.[0]).toMatchObject({ input_price: 9, output_price: 27 });
    expect(profile.schedule?.some((slot) => slot.factor === 0.5)).toBe(true);
  });

  it('图片模型生成按张计费', () => {
    expect(catalogPricingProfile(getCatalogPrice('kling-image-v3')!)).toEqual({
      image_billing_mode: 'per_image',
      image: { default: 0.2 },
    });
  });
});

describe('resolveExtraPrice', () => {
  it('没填价格时用目录价并带上缓存价与完整计费配置', () => {
    expect(resolveExtraPrice('kimi-k3')).toMatchObject({
      inputPrice: 20,
      outputPrice: 100,
      imagePrice: null,
      cacheRead: 2,
      pricingProfile: {
        tiers: [{ upto: null, input_price: 20, output_price: 100, cache_read_price: 2 }],
      },
    });
  });

  it('目录价带阶梯时保留全部档位', () => {
    const resolved = resolveExtraPrice('minimax-m3')!;
    expect(resolved.pricingProfile.tiers).toHaveLength(2);
    expect(resolved.inputPrice).toBe(2.1);
  });

  it('管理员填的价格优先，改过价就不带缓存价', () => {
    expect(resolveExtraPrice('kimi-k3', 18, 90)).toMatchObject({
      inputPrice: 18,
      outputPrice: 90,
      imagePrice: null,
      cacheRead: null,
      pricingProfile: { tiers: [{ upto: null, input_price: 18, output_price: 90 }] },
    });
  });

  it('与目录价一致时仍带缓存价', () => {
    expect(resolveExtraPrice('kimi-k3', 20, 100)?.cacheRead).toBe(2);
  });

  it('图片模型返回按张价', () => {
    expect(resolveExtraPrice('seedream-image-v5.0-flash')).toMatchObject({
      inputPrice: 0,
      outputPrice: 0,
      imagePrice: 0.12,
      cacheRead: null,
      pricingProfile: { image_billing_mode: 'per_image', image: { default: 0.12 } },
    });
  });

  it('显式按张价优先于目录价', () => {
    expect(resolveExtraPrice('kling-image-v3', 0, 0, 0.3)?.imagePrice).toBe(0.3);
  });

  it('目录有价但网关计费方式表达不了时返回 null', () => {
    expect(resolveExtraPrice('kling-video-v4')).toBeNull();
    expect(resolveExtraPrice('kling-video-v4', 0, 0)).toBeNull();
  });

  it('目录里没有的模型返回 null', () => {
    expect(resolveExtraPrice('qwen3-max')).toBeNull();
  });
});
