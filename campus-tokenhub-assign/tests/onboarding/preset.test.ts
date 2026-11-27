import { describe, expect, it } from 'vitest';
import { CURRENT_PRESET, FEATURED_MODEL_IDS, defaultSelectedModelIds } from '@/lib/onboarding/preset';
import { catalogSupportsReasoning } from '@/lib/onboarding/model-catalog';

describe('默认勾选的主流模型', () => {
  const defaults = defaultSelectedModelIds();

  it('默认数量明显少于全量，避免一上来全选', () => {
    expect(defaults.length).toBeGreaterThan(0);
    expect(defaults.length).toBeLessThan(CURRENT_PRESET.models.length / 2);
  });

  it('同一家族只保留最高版本：选了 glm-5.3 就不再默认选 glm-5.2', () => {
    expect(defaults).toContain('glm-5.3');
    expect(defaults).not.toContain('glm-5.2');
  });

  it('默认列表里的 id 都能在清单里找到', () => {
    const known = new Set(CURRENT_PRESET.models.map((model) => model.id));
    for (const id of FEATURED_MODEL_IDS) {
      expect(known.has(id), id).toBe(true);
    }
  });

  it('文本与多模态各留有主流模型，图像与向量保留全部现有模型', () => {
    expect(defaults).toContain('hy4');
    expect(defaults).toContain('deepseek-v4.1-flash-1017');
    expect(defaults).toContain('kimi-k3.1-pro');
    expect(defaults).toContain('kling-image-v3');
    expect(defaults).toContain('seedream-image-v5.0-flash');
    expect(defaults).toContain('kinfra-text-embedding-4b');
  });

  it('DeepSeek 用 1017 固定快照，不带后缀的别名不再默认勾选', () => {
    expect(defaults).toContain('deepseek-v4.1-flash-1017');
    expect(defaults).not.toContain('deepseek-v4.1-flash');
  });

  it('补登记的模型进了清单，且与导出结果不重复', () => {
    const ids = CURRENT_PRESET.models.map((model) => model.id);
    expect(ids).toContain('deepseek-v4.1-flash-1017');
    expect(new Set(ids).size).toBe(ids.length);

    const model = CURRENT_PRESET.models.find((item) => item.id === 'deepseek-v4.1-flash-1017');
    expect(model).toMatchObject({
      displayName: 'DeepSeek-V4.1-Flash-1017',
      route: { providerModelName: 'deepseek-v4.1-flash-1017', upstreamOperation: 'chat' },
    });
  });
});

describe('深度思考能力（官方「能力支持」列）', () => {
  it('语言模型里标注深度思考的都为 true', () => {
    const ids = [
      'deepseek-v4.1-flash',
      'deepseek/deepseek-flash',
      'glm-5.3',
      'glm-5.3-flash',
      'hy3',
      'hy4',
      'kimi-k3.1-pro',
      'kimi-k2.7-code',
      'minimax-m3',
      'minimax-m3.1-flash',
      'mimo-v2.6-flash',
      'step-5-preview',
    ];
    for (const id of ids) {
      expect(catalogSupportsReasoning(id), id).toBe(true);
    }
  });

  it('快思考、视频理解、翻译、角色扮演模型不标深度思考', () => {
    const ids = [
      'hy-vision-2.0-instruct',
      'hunyuan-turbos-vision-video-20250728',
      'youtu-vita',
      'hy-mt2-pro',
      'hy-role',
      'hunyuan-role-latest',
    ];
    for (const id of ids) {
      expect(catalogSupportsReasoning(id), id).toBe(false);
    }
  });

  it('目录里没有的模型按不支持处理，不瞎猜', () => {
    expect(catalogSupportsReasoning('some-new-model')).toBe(false);
  });
});
