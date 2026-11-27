import { describe, expect, it } from 'vitest';
import {
  CATALOG_CATEGORY_ORDER,
  describeModelCapabilities,
  resolveCatalogCategories,
  resolveCatalogCategory,
  type CatalogCategoryKey,
} from '@/lib/gateway/catalog-category';
import type { CatalogModel } from '@/lib/gateway/types';

type Fixture = Pick<CatalogModel, 'input_modalities' | 'output_modalities'> & {
  id?: string;
  display_name?: string | null;
};

function fixture(input: string[], output: string[]): Fixture {
  return { input_modalities: input, output_modalities: output };
}

describe('resolveCatalogCategory', () => {
  const cases: Array<[string, Fixture | null, CatalogCategoryKey]> = [
    ['纯文本对话模型 → 大语言模型', fixture(['text'], ['text']), 'chat'],
    ['图片理解模型主分类仍是大语言模型', fixture(['text', 'image'], ['text']), 'chat'],
    ['向量模型', fixture(['text'], ['embedding']), 'embedding'],
    ['图像生成模型', fixture(['text', 'image'], ['image']), 'image'],
    ['视频生成模型', fixture(['text'], ['video']), 'video'],
    ['语音合成模型', fixture(['text'], ['audio']), 'tts'],
    ['没有模态信息按大语言模型处理', null, 'chat'],
  ];

  it.each(cases)('%s', (_name, model, expected) => {
    expect(resolveCatalogCategory(model)).toBe(expected);
  });

  it('分类顺序与设计稿一致', () => {
    expect(CATALOG_CATEGORY_ORDER).toEqual([
      'chat',
      'code',
      'multimodal',
      'image',
      'video',
      'embedding',
      'asr',
      'tts',
    ]);
  });
});

describe('resolveCatalogCategories', () => {
  it('多模态模型同时属于大语言模型与多模态理解', () => {
    expect(resolveCatalogCategories(fixture(['text', 'image'], ['text']))).toEqual(['chat', 'multimodal']);
  });

  it('代码模型按 ID 命中', () => {
    const model: Fixture = {
      ...fixture(['text'], ['text']),
      id: 'kimi-k2.7-code',
      display_name: 'Kimi K2.7 Code',
    };
    expect(resolveCatalogCategories(model)).toContain('code');
    expect(resolveCatalogCategories(model)).toContain('chat');
  });

  it('相似词不会误判成代码模型', () => {
    const model: Fixture = { ...fixture(['text'], ['text']), id: 'decode-model', display_name: 'Decode' };
    expect(resolveCatalogCategories(model)).toEqual(['chat']);
  });

  it('纯语音转写模型只归语音识别，不并入大语言模型', () => {
    expect(resolveCatalogCategories(fixture(['audio'], ['text']))).toEqual(['asr']);
  });

  it('图像/视频生成模型是互斥分类', () => {
    expect(resolveCatalogCategories(fixture(['text', 'image'], ['image']))).toEqual(['image']);
    expect(resolveCatalogCategories(fixture(['text'], ['embedding']))).toEqual(['embedding']);
  });
});

describe('describeModelCapabilities', () => {
  it('纯文本对话只显示「纯文本」', () => {
    expect(describeModelCapabilities(fixture(['text'], ['text']))).toEqual(['纯文本']);
  });

  it('图片理解不再被 input 只有 text 的历史数据影响时按实际模态展示', () => {
    expect(describeModelCapabilities(fixture(['text', 'image'], ['text']))).toEqual(['图片理解']);
    expect(describeModelCapabilities(fixture(['text', 'image', 'video'], ['text']))).toEqual([
      '图片理解',
      '视频理解',
    ]);
  });

  it('全模态输入按图片、视频、语音、文件顺序排列', () => {
    expect(describeModelCapabilities(fixture(['audio', 'image', 'text', 'video'], ['text']))).toEqual([
      '图片理解',
      '视频理解',
      '语音理解',
    ]);
  });

  it('图像生成显示「文生图」，有 image 输入再加「参考图」', () => {
    expect(describeModelCapabilities(fixture(['text'], ['image']))).toEqual(['文生图']);
    expect(describeModelCapabilities(fixture(['image', 'text'], ['image']))).toEqual(['文生图', '参考图']);
  });

  it('向量模型固定「文本向量化」', () => {
    expect(describeModelCapabilities(fixture(['text'], ['embedding']))).toEqual(['文本向量化']);
  });

  it('语音合成与纯语音转写各自有固定标签', () => {
    expect(describeModelCapabilities(fixture(['text'], ['audio']))).toEqual(['语音合成']);
    expect(describeModelCapabilities(fixture(['audio'], ['text']))).toEqual(['语音转写']);
  });
});
