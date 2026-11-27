/**
 * 模型集市的分类，对齐设计稿的 9 个标签。
 *
 * 与早期「只按输出模态分 3 类」的区别：
 * - **大语言模型**是输出文字的模型全集；
 * - **代码** / **多模态理解** / **语音识别** 是它的子集，会与「大语言模型」重复计数，
 *   设计稿上的分类计数也确实是重叠的（各类相加大于总数）；
 * - 空分类由页面隐藏，所以模型池里没有的类别不会出现死标签。
 *
 * 判定口径：
 * - 输出含 `embedding` → 向量嵌入（互斥，直接返回）
 * - 输出含 `image` → 文生图；`video` → 文生视频；`audio` → 语音合成（互斥）
 * - 输出文字：一律算大语言模型；其中输入含 image/video/audio 的再加「多模态理解」；
 *   ID/名称命中 code/coder 的再加「代码」
 * - 输出文字且只吃 audio（没有图像/视频）的纯转写模型单独归「语音识别」
 */

export type CatalogCategoryKey =
  | 'chat'
  | 'code'
  | 'multimodal'
  | 'image'
  | 'video'
  | 'embedding'
  | 'asr'
  | 'tts';

export type CatalogCategoryMeta = {
  /** tab 上的短名 */
  label: string;
  /** 分类说明，用于 tab 的 title 与无障碍描述 */
  hint: string;
};

/** 展示顺序即 tab 顺序；空分类由页面自行隐藏。 */
export const CATALOG_CATEGORY_ORDER: CatalogCategoryKey[] = [
  'chat',
  'code',
  'multimodal',
  'image',
  'video',
  'embedding',
  'asr',
  'tts',
];

export const CATALOG_CATEGORY_META: Record<CatalogCategoryKey, CatalogCategoryMeta> = {
  chat: { label: '大语言模型', hint: '输出文字的模型全集，含多模态理解与代码模型。' },
  code: { label: '代码', hint: '面向代码生成与补全的模型。' },
  multimodal: { label: '多模态理解', hint: '输入可以带图片、视频或语音。' },
  image: { label: '文生图', hint: '输出图片，按张计价。' },
  video: { label: '文生视频', hint: '输出视频。' },
  embedding: { label: '向量嵌入', hint: '把文本转成向量，用于检索与知识库。' },
  asr: { label: '语音识别', hint: '语音转文字。' },
  tts: { label: '语音合成', hint: '文字转语音。' },
};

/** 测试与调用方都可以只传模态；id/名称用于识别代码模型，缺省时不影响其它判定。 */
type CategoryInput =
  | {
      id?: string | null;
      display_name?: string | null;
      input_modalities?: string[] | null;
      output_modalities?: string[] | null;
    }
  | null
  | undefined;

/** `kimi-k2.7-code` / `codestral` 这类命名，用分隔符界定，避免 `decode` 误命中 */
const CODE_ID = /(?:^|[-_/.])(?:code|coder|coding|codex)(?:$|[-_/.])/i;
const CODE_NAME = /编程|代码|\bcode\b|\bcoder\b/i;

function isCodeModel(model: CategoryInput): boolean {
  const id = model?.id ?? '';
  const name = model?.display_name ?? '';
  return CODE_ID.test(id) || CODE_NAME.test(name);
}

const MEDIA_INPUTS = ['image', 'video', 'audio'];

/** 一个模型可以同时属于多个分类（大语言模型与其子集）。 */
export function resolveCatalogCategories(model: CategoryInput): CatalogCategoryKey[] {
  const output = model?.output_modalities ?? [];

  if (output.includes('embedding')) return ['embedding'];
  if (output.includes('image')) return ['image'];
  if (output.includes('video')) return ['video'];
  if (output.includes('audio')) return ['tts'];

  const input = model?.input_modalities ?? [];
  const understandsMedia = MEDIA_INPUTS.some((modality) => input.includes(modality));
  const voiceOnly = input.includes('audio') && !input.includes('image') && !input.includes('video');

  // 纯转写模型不是对话模型，不并入大语言模型
  if (voiceOnly) return ['asr'];

  const keys: CatalogCategoryKey[] = ['chat'];
  if (understandsMedia) keys.push('multimodal');
  if (isCodeModel(model)) keys.push('code');
  return keys;
}

/** 主分类：用于卡片角标、详情页这类只需要一个归属的场景。 */
export function resolveCatalogCategory(model: CategoryInput): CatalogCategoryKey {
  return resolveCatalogCategories(model)[0] ?? 'chat';
}

const INPUT_LABEL: Record<string, string> = {
  image: '图片理解',
  video: '视频理解',
  audio: '语音理解',
  file: '文件输入',
};

const INPUT_ORDER = ['image', 'video', 'audio', 'file'];

/** 图像生成类模型的 image 输入是「参考图」，不叫理解。 */
const IMAGE_CATEGORY_LABEL: Record<string, string> = {
  image: '参考图',
};

/**
 * 卡片上的能力标签。
 *
 * 对话模型：纯文本 → 「纯文本」；能吃多模态 → 「图片理解 / 视频理解 / …」。
 * 图像生成：固定「文生图」，有 image 输入再加「参考图」。
 * 向量：固定「文本向量化」。语音合成：固定「语音合成」。
 */
export function describeModelCapabilities(model: CategoryInput): string[] {
  const category = resolveCatalogCategory(model);
  const inputs = model?.input_modalities ?? [];

  if (category === 'embedding') return ['文本向量化'];
  if (category === 'tts') return ['语音合成'];
  if (category === 'asr') {
    return ['语音转写'];
  }

  if (category === 'image') {
    const labels = ['文生图'];
    for (const input of INPUT_ORDER) {
      if (inputs.includes(input)) labels.push(IMAGE_CATEGORY_LABEL[input] ?? INPUT_LABEL[input]);
    }
    return labels;
  }

  const labels = INPUT_ORDER.filter((input) => inputs.includes(input)).map((input) => INPUT_LABEL[input]);
  return labels.length > 0 ? labels : ['纯文本'];
}
