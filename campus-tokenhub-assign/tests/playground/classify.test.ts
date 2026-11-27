import { describe, expect, it } from 'vitest';
import { classifyModels, flattenOptions } from '@/lib/playground/classify';
import type { CatalogModel } from '@/lib/gateway/types';

function model(id: string, operations: string[], extra: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    display_name: id.toUpperCase(),
    vendor: 'tencent',
    context_window: 128000,
    max_tokens: 4096,
    input_modalities: ['text'],
    output_modalities: ['text'],
    inbound: operations.map((operation) => ({ protocol: 'openai', operation })),
    route_groups: ['default'],
    tags: [],
    pricing_profile: { tiers: [{ input_price: 1, output_price: 2 }] },
    discounts: {},
    ...extra,
  };
}

describe('classifyModels', () => {
  it('按 operation 归入对话 / 图像 / 向量', () => {
    const result = classifyModels([
      model('a-chat', ['chat']),
      model('b-resp', ['responses']),
      model('c-msg', ['messages']),
      model('d-gen', ['models.generate']),
      model('e-img', ['images.generations']),
      model('f-emb', ['embeddings']),
    ]);

    expect(result.chat.map((item) => item.modelId).sort()).toEqual(['a-chat', 'b-resp', 'c-msg', 'd-gen']);
    expect(result.image.map((item) => item.modelId)).toEqual(['e-img']);
    expect(result.embedding.map((item) => item.modelId)).toEqual(['f-emb']);
  });

  it('一个模型多种 operation 时给多个可选项', () => {
    const result = classifyModels([model('multi', ['chat', 'embeddings'])]);

    expect(flattenOptions(result)).toHaveLength(2);
    expect(result.chat[0]).toMatchObject({ operation: 'chat', supported: true });
  });

  it('只有 chat / images.generations / embeddings 有真表单，其余标记为不支持', () => {
    const result = classifyModels([model('x', ['responses', 'images.edits', 'chat'])]);

    const byOperation = Object.fromEntries(
      flattenOptions(result).map((option) => [option.operation, option.supported])
    );
    expect(byOperation).toEqual({ responses: false, 'images.edits': false, chat: true });
  });

  it('语音与视频生成模型不进入任何分组', () => {
    const result = classifyModels([
      model('tts', ['audio.speech']),
      model('asr', ['audio.transcriptions']),
      model('video', ['videos.generations']),
    ]);

    expect(result).toEqual({});
  });

  it('空分组被过滤掉', () => {
    const result = classifyModels([model('only-chat', ['chat'])]);
    expect(Object.keys(result)).toEqual(['chat']);
  });

  it('白名单外与非字符串 operation 被过滤', () => {
    const result = classifyModels(
      [
        model('keep', ['chat']),
        model('drop', ['chat']),
        { ...model('weird', []), inbound: [{ protocol: 'openai' }] },
      ],
      { allowlist: ['keep'] }
    );

    expect(result.chat.map((item) => item.modelId)).toEqual(['keep']);
  });

  it('白名单为空时展示全部', () => {
    const result = classifyModels([model('a', ['chat']), model('b', ['chat'])], { allowlist: [] });
    expect(result.chat).toHaveLength(2);
  });

  it('discontinued 模型与本次会话被标记的模型始终排除', () => {
    const result = classifyModels(
      [model('alive', ['chat']), model('dead', ['chat'], { status: 'discontinued' }), model('blocked', ['chat'])],
      { blocked: ['blocked'] }
    );

    expect(result.chat.map((item) => item.modelId)).toEqual(['alive']);
  });

  it('display_name 缺失时回退到 id', () => {
    const result = classifyModels([model('hy4', ['chat'], { display_name: null })]);
    expect(result.chat[0].displayName).toBe('hy4');
  });
});
