import { describe, expect, it } from 'vitest';
import {
  MODEL_CATEGORY_ORDER,
  inferCategoryFromId,
  resolveModelCategory,
  type ModelCategoryKey,
} from '@/lib/onboarding/model-category';

describe('resolveModelCategory', () => {
  const cases: Array<[string, string[] | null, ModelCategoryKey]> = [
    ['纯文本对话 → 对话', ['text'], 'chat'],
    ['图片输入、文本输出也归对话（不再单列多模态）', ['text'], 'chat'],
    ['图像生成', ['image'], 'image'],
    ['向量模型', ['embedding'], 'embedding'],
    ['语音模型', ['audio'], 'audio'],
    ['视频模型', ['video'], 'video'],
    ['3D 模型', ['model'], '3d'],
    ['没有模态信息时按对话处理', null, 'chat'],
  ];

  it.each(cases)('%s', (_name, output, expected) => {
    expect(resolveModelCategory(output)).toBe(expected);
  });

  it('对话排在第一类，向导按此顺序逐步选择', () => {
    expect(MODEL_CATEGORY_ORDER[0]).toBe('chat');
    expect(MODEL_CATEGORY_ORDER as string[]).not.toContain('multimodal');
  });
});

describe('inferCategoryFromId', () => {
  it.each([
    ['glm-6-preview', 'chat'],
    ['hunyuan-turbos-latest', 'chat'],
    ['qwen3-max', 'chat'],
    ['qwen-vl-max', 'chat'],
    ['kimi-k4-vision', 'chat'],
    ['hy-video-v1.5', 'video'],
    ['kling-video-v4', 'video'],
    ['hy-world2-scene', '3d'],
    ['tripo-3d-p1', '3d'],
    ['minimax-music-v2.6', 'music'],
    ['seedream-image-v6', 'image'],
    ['kling-image-v4', 'image'],
    ['hy-asr-4.0', 'audio'],
    ['minimax-speech-2.6', 'audio'],
    ['bge-m3-embedding', 'embedding'],
  ])('%s → %s', (id, expected) => {
    expect(inferCategoryFromId(id)).toBe(expected);
  });
});
