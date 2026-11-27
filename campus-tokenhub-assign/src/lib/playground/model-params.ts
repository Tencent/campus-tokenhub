/**
 * 图像模型的参数集差异。
 *
 * 上游是 TokenHub，同一类 `images.generations` 有两套完全不同的参数形态，
 * 所以表单必须两级驱动：operation 选大类，模型族选字段。映射表放代码里，
 * 因为网关的 `metadata` 不会出现在 catalog 响应里。
 */

export type ImageFamily = 'seedream' | 'kling' | 'generic';

export function imageFamily(modelId: string): ImageFamily {
  const id = modelId.toLowerCase();
  if (id.includes('seedream')) return 'seedream';
  if (id.includes('kling')) return 'kling';
  return 'generic';
}

/** Seedream：分辨率档位（也接受 `宽x高`） */
export const SEEDREAM_SIZES = ['1K', '1.5K', '2K'] as const;

/** Kling：纵横比 + 分辨率，另有 negative_prompt */
export const KLING_ASPECT_RATIOS = [
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '3:2',
  '2:3',
  '21:9',
] as const;

export const KLING_RESOLUTIONS = ['1k', '2k'] as const;

export const IMAGE_FAMILY_LABEL: Record<ImageFamily, string> = {
  seedream: 'Seedream（分辨率档位）',
  kling: 'Kling（纵横比 + 分辨率）',
  generic: '通用（size 可选）',
};

/** 已知向量维度，用于结果区提示 */
export const EMBEDDING_DIMENSIONS: Record<string, number> = {
  'kinfra-text-embedding-4b': 2560,
  'kinfra-text-embedding-0.6b': 1024,
};

export function knownEmbeddingDimension(modelId: string): number | null {
  return EMBEDDING_DIMENSIONS[modelId] ?? null;
}
