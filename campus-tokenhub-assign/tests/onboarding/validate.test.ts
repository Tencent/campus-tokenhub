import { describe, expect, it } from 'vitest';
import { normalizeApiKey, normalizeExtraModels, normalizeModelIds } from '@/lib/onboarding/validate';
import { ApiError } from '@/lib/api/guard';

describe('normalizeApiKey', () => {
  it('接受常规 Key 并去掉首尾空白', () => {
    expect(normalizeApiKey('  sk-abcdef123456  ')).toBe('sk-abcdef123456');
  });

  it('拒绝过短或含空白的值', () => {
    expect(() => normalizeApiKey('short')).toThrow(ApiError);
    expect(() => normalizeApiKey('sk-abc def ghi')).toThrow(ApiError);
    expect(() => normalizeApiKey(undefined)).toThrow(ApiError);
  });
});

describe('normalizeModelIds', () => {
  it('只保留推荐清单里存在的模型并去重', () => {
    const ids = normalizeModelIds(['hy4', 'hy4', 'not-in-preset']);
    expect(ids).toEqual(['hy4']);
  });

  it('一个都不合法时报 400', () => {
    expect(() => normalizeModelIds(['not-in-preset'])).toThrow(ApiError);
    expect(() => normalizeModelIds('hy4')).toThrow(ApiError);
  });
});

describe('normalizeExtraModels', () => {
  it('未收录模型必须带大于 0 的输入价', () => {
    expect(() => normalizeExtraModels([{ id: 'glm-6', inputPrice: 0, outputPrice: 8 }])).toThrow(ApiError);
    expect(() => normalizeExtraModels([{ id: 'glm-6', inputPrice: -1, outputPrice: 8 }])).toThrow(ApiError);
  });

  it('已收录的 id 与重复 id 直接忽略', () => {
    expect(normalizeExtraModels([{ id: 'hy4', inputPrice: 2, outputPrice: 8 }])).toEqual([]);
    expect(
      normalizeExtraModels([
        { id: 'glm-6', inputPrice: 2, outputPrice: 8 },
        { id: 'glm-6', inputPrice: 3, outputPrice: 9 },
      ])
    ).toEqual([{ id: 'glm-6', inputPrice: 2, outputPrice: 8 }]);
  });

  it('正常补价后返回结构化数据', () => {
    expect(normalizeExtraModels([{ id: 'qwen3-max', inputPrice: 2.5, outputPrice: 10 }])).toEqual([
      { id: 'qwen3-max', inputPrice: 2.5, outputPrice: 10 },
    ]);
  });

  it('没填价格时取静态价目表：token 模型带缓存价，图片模型带按张价', () => {
    expect(normalizeExtraModels([{ id: 'kimi-k2.6' }])).toEqual([
      { id: 'kimi-k2.6', inputPrice: 6.5, outputPrice: 27, cacheRead: 1.1 },
    ]);
    expect(normalizeExtraModels([{ id: 'kling-image-o1' }])).toEqual([
      { id: 'kling-image-o1', inputPrice: 0, outputPrice: 0, imagePrice: 0.2 },
    ]);
  });

  it('视频/3D 等网关表达不了的计费方式给出明确原因，不再要求手填价格', () => {
    expect(() => normalizeExtraModels([{ id: 'kling-video-v4' }])).toThrow(/网关暂无视频生成接口/);
    expect(() => normalizeExtraModels([{ id: 'hy-world2-scene' }])).toThrow(/网关暂无 3D 生成接口/);
  });

  it('完全不在腾讯云目录里的模型直接拒绝', () => {
    expect(() => normalizeExtraModels([{ id: 'qwen3-max' }])).toThrow(/不在腾讯云模型目录/);
  });
});
