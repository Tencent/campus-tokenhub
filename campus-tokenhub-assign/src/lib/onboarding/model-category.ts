/**
 * 模型类型分组：初始化向导按类型逐类选择，右侧实时展示已选结果。
 *
 * 文本与多模态合并为「对话」——实际业务里同一个模型往往既能纯文本、也能吃图片，
 * 按输入模态拆开会把同家族模型分散到两个 tab，反而不好选。
 *
 * 只依据输出模态判断：
 * - 输出有 embedding → 向量
 * - 输出有 image → 图像生成
 * - 输出有 audio → 语音
 * - 输出文本（或没有模态信息）→ 对话
 */

export type ModelCategoryKey = 'chat' | 'image' | 'embedding' | 'audio' | 'video' | 'music' | '3d' | 'other';

export type ModelCategoryMeta = {
  label: string;
  /** 标签页用的短名，保证分类能在一行内放下 */
  short: string;
  hint: string;
};

/** 展示顺序即向导里的步骤顺序。 */
export const MODEL_CATEGORY_ORDER: ModelCategoryKey[] = [
  'chat',
  'image',
  'embedding',
  'audio',
  'video',
  'music',
  '3d',
  'other',
];

export const MODEL_CATEGORY_META: Record<ModelCategoryKey, ModelCategoryMeta> = {
  chat: { label: '对话模型', short: '对话', hint: '文本与多模态对话模型，输入可包含图片、视频或文件。' },
  image: { label: '图像生成', short: '图像', hint: '输出图片；需要先在上游开通「在线推理-后付费」。' },
  embedding: { label: '向量', short: '向量', hint: '文本向量化，用于检索与知识库。' },
  audio: { label: '语音', short: '语音', hint: '语音识别或语音合成；网关暂不导入，仅展示参数与价格。' },
  video: { label: '视频生成', short: '视频', hint: '文生视频、图生视频；网关暂不导入，仅展示参数与价格。' },
  music: { label: '音乐生成', short: '音乐', hint: '歌曲与配乐生成；网关暂不导入，仅展示参数与价格。' },
  '3d': { label: '3D 生成', short: '3D', hint: '3D 模型与场景生成；网关暂不导入，仅展示参数与价格。' },
  other: { label: '其他', short: '其他', hint: '未归类的模型。' },
};

export function resolveModelCategory(outputModalities: string[] | null | undefined): ModelCategoryKey {
  const output = new Set(outputModalities ?? []);
  if (output.has('embedding')) return 'embedding';
  if (output.has('image')) return 'image';
  if (output.has('video')) return 'video';
  if (output.has('model')) return '3d';
  if (output.has('audio')) return 'audio';
  if (output.has('text') || output.size === 0) return 'chat';
  return 'other';
}

/**
 * 上游返回、但腾讯云目录里没有的模型：拿不到模态信息，只能按 id 猜个分类用于展示。
 * 这些模型没有官方价，初始化向导里只展示、不可勾选。
 */
const ID_HINTS: Array<[ModelCategoryKey, RegExp]> = [
  ['embedding', /embed|bge|gte/i],
  ['video', /video|seedance|sora|veo|kling-?video|vidu-?video|pixverse/i],
  ['3d', /3d|mesh|polygen|world2|panorama|retopolog|rigging/i],
  ['image', /image|seedream|imagen|flux|diffusion|dall-?e|kling-image|kolors/i],
  ['music', /music|mureka|suno|audio-?gen/i],
  ['audio', /asr|tts|speech|audio|voice|whisper|dubbing/i],
];

export function inferCategoryFromId(id: string): ModelCategoryKey {
  for (const [category, pattern] of ID_HINTS) {
    if (pattern.test(id)) return category;
  }
  return 'chat';
}

/** 上游未收录模型的厂商推断，只用于列表展示；猜不出来按腾讯（当前上游）处理。 */
const VENDOR_HINTS: Array<[string, RegExp]> = [
  ['deepseek', /deepseek/i],
  ['zhipu', /glm|zhipu|chatglm/i],
  ['moonshot', /kimi|moonshot/i],
  ['minimax', /minimax|abab/i],
  ['xiaomi', /mimo/i],
  ['stepfun', /step-\d/i],
  ['aliyun', /qwen|tongyi/i],
  ['bytedance', /doubao|seedream|seededit|skylark/i],
  ['kuaishou', /kling|kl-video/i],
  ['shengshu', /vidu|vd-video/i],
  ['pixverse', /pixverse/i],
  ['mureka', /mureka/i],
  ['hidream', /hidream/i],
  ['kinfra', /kinfra/i],
  ['baidu', /ernie|wenxin/i],
  ['tencent', /hunyuan|^hy[\d-]|^hy-|wand|youtu|^yt-|tenlai|hi3d|rodin/i],
];

export function inferVendorFromId(id: string): string {
  for (const [vendor, pattern] of VENDOR_HINTS) {
    if (pattern.test(id)) return vendor;
  }
  return 'tencent';
}
