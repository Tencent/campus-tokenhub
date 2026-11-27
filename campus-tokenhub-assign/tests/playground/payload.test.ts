import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_TOKENS, PayloadError, buildPayload } from '@/lib/playground/payload';
import type { CatalogModel } from '@/lib/gateway/types';

function model(id: string, modalities: string[] = ['text'], operation = 'chat'): CatalogModel {
  return {
    id,
    display_name: id,
    vendor: 'tencent',
    context_window: 128000,
    max_tokens: 4096,
    input_modalities: modalities,
    output_modalities: ['text'],
    inbound: [{ protocol: 'openai', operation }],
    route_groups: ['default'],
    tags: [],
    pricing_profile: { tiers: [{ input_price: 1 }] },
    discounts: {},
  };
}

const chatModel = model('hy4', ['text']);

describe('对话表单', () => {
  it('生成合法的 messages，默认 max_tokens 1024', () => {
    const built = buildPayload({
      model: chatModel,
      operation: 'chat',
      form: { messages: [{ role: 'user', content: '你好' }] },
    });

    expect(built.path).toBe('/v1/chat/completions');
    expect(built.method).toBe('POST');
    expect(built.body).toMatchObject({
      model: 'hy4',
      messages: [{ role: 'user', content: '你好' }],
      max_tokens: DEFAULT_MAX_TOKENS,
      stream: false,
    });
  });

  it('system prompt 与采样参数只在有值时出现', () => {
    const built = buildPayload({
      model: chatModel,
      operation: 'chat',
      form: {
        system: '你是助教',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.7,
        maxTokens: 2048,
        topP: 0.9,
        stream: true,
      },
    });

    expect(built.body.messages).toEqual([
      { role: 'system', content: '你是助教' },
      { role: 'user', content: 'hi' },
    ]);
    expect(built.body).toMatchObject({ temperature: 0.7, max_tokens: 2048, top_p: 0.9, stream: true });
  });

  it('没有消息时抛 empty_input', () => {
    expect(() =>
      buildPayload({ model: chatModel, operation: 'chat', form: { messages: [{ role: 'user', content: '  ' }] } })
    ).toThrow(PayloadError);
  });

  it('图片只在 input_modalities 含 image 时拼进内容', () => {
    const withImage = buildPayload({
      model: model('vision', ['text', 'image']),
      operation: 'chat',
      form: { messages: [{ role: 'user', content: '看图' }], imageUrls: ['https://x/a.png'] },
    });
    const content = (withImage.body.messages as { content: unknown }[])[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'https://x/a.png' } },
    ]);

    const withoutImage = buildPayload({
      model: chatModel,
      operation: 'chat',
      form: { messages: [{ role: 'user', content: '看图' }], imageUrls: ['https://x/a.png'] },
    });
    expect((withoutImage.body.messages as { content: unknown }[])[0].content).toBe('看图');
  });

  it('视频只在 input_modalities 含 video 时按 video_url 拼入', () => {
    const built = buildPayload({
      model: model('video-vision', ['text', 'video']),
      operation: 'chat',
      form: {
        messages: [{ role: 'user', content: '看视频' }],
        videoUrl: 'https://x/a.mp4',
        imageUrls: ['https://x/ignored.png'],
      },
    });

    expect((built.body.messages as { content: unknown }[])[0].content).toEqual([
      { type: 'text', text: '看视频' },
      { type: 'video_url', video_url: { url: 'https://x/a.mp4' } },
    ]);
  });
});

describe('图像表单', () => {
  it('Seedream 族用 size 档位', () => {
    const built = buildPayload({
      model: model('seedream-image-v5.0-flash', ['text'], 'images.generations'),
      operation: 'images.generations',
      form: { prompt: '一只猫', size: '2K', n: 1, responseFormat: 'url' },
    });

    expect(built.body).toEqual({
      model: 'seedream-image-v5.0-flash',
      prompt: '一只猫',
      n: 1,
      response_format: 'url',
      size: '2K',
    });
  });

  it('Kling 族用 aspect_ratio + resolution + negative_prompt', () => {
    const built = buildPayload({
      model: model('kling-image-v3', ['text'], 'images.generations'),
      operation: 'images.generations',
      form: {
        prompt: '山海',
        aspectRatio: '16:9',
        resolution: '2k',
        negativePrompt: '模糊',
        size: '1K',
      },
    });

    expect(built.body).toMatchObject({
      aspect_ratio: '16:9',
      resolution: '2k',
      negative_prompt: '模糊',
    });
    expect(built.body).not.toHaveProperty('size');
  });

  it('未识别的模型族回退到通用 size', () => {
    const built = buildPayload({
      model: model('wand-vega-image-lite', ['text'], 'images.generations'),
      operation: 'images.generations',
      form: { prompt: 'x', size: '1024x1024' },
    });

    expect(built.body.size).toBe('1024x1024');
  });

  it('prompt 为空时抛 empty_input', () => {
    expect(() =>
      buildPayload({
        model: model('seedream-image-v5.0-flash', ['text'], 'images.generations'),
        operation: 'images.generations',
        form: { prompt: '   ' },
      })
    ).toThrow(PayloadError);
  });
});

describe('向量表单', () => {
  it('单条文本', () => {
    const built = buildPayload({
      model: model('kinfra-text-embedding-4b', ['text'], 'embeddings'),
      operation: 'embeddings',
      form: { input: 'hello' },
    });

    expect(built.path).toBe('/v1/embeddings');
    expect(built.body).toEqual({ model: 'kinfra-text-embedding-4b', input: 'hello' });
  });

  it('多条文本走数组', () => {
    const built = buildPayload({
      model: model('kinfra-text-embedding-4b', ['text'], 'embeddings'),
      operation: 'embeddings',
      form: { inputs: ['a', 'b'] },
    });

    expect(built.body.input).toEqual(['a', 'b']);
  });

  it('空输入抛 empty_input', () => {
    expect(() =>
      buildPayload({
        model: model('kinfra-text-embedding-4b', ['text'], 'embeddings'),
        operation: 'embeddings',
        form: {},
      })
    ).toThrow(PayloadError);
  });
});

describe('高级参数', () => {
  it('与表单冲突时以高级参数为准', () => {
    const built = buildPayload({
      model: chatModel,
      operation: 'chat',
      form: { messages: [{ role: 'user', content: 'hi' }], maxTokens: 1024 },
      advancedJson: '{"max_tokens": 64, "seed": 42, "watermark": true}',
    });

    expect(built.body.max_tokens).toBe(64);
    expect(built.body).toMatchObject({ seed: 42, watermark: true });
  });

  it('非法 JSON 抛可识别错误', () => {
    try {
      buildPayload({
        model: chatModel,
        operation: 'chat',
        form: { messages: [{ role: 'user', content: 'hi' }] },
        advancedJson: '{bad json',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PayloadError);
      expect((error as PayloadError).code).toBe('bad_advanced_json');
    }
  });

  it('JSON 不是对象时也拒绝', () => {
    expect(() =>
      buildPayload({
        model: chatModel,
        operation: 'chat',
        form: { messages: [{ role: 'user', content: 'hi' }] },
        advancedJson: '[1,2,3]',
      })
    ).toThrow(PayloadError);
  });
});

describe('未实现的操作', () => {
  it('标记 unsupported 且只保留最小 body', () => {
    const built = buildPayload({
      model: model('x', ['text'], 'responses'),
      operation: 'responses',
      form: {},
    });

    expect(built).toMatchObject({ path: '/v1/responses', unsupported: true, body: { model: 'x' } });
  });
});
