/**
 * 把目录里的模型按「能调试什么」归类。
 *
 * 只做三类：对话 / 图像 / 向量。语音（`audio.*`）与视频生成**不出现**在任何分组里，
 * 也不给「暂不支持」的占位——那会让学生以为是权限问题去找老师。
 * 视频理解走对话表单（多模态输入），不在生成侧。
 */

import type { CatalogModel } from '@/lib/gateway/types';

export type PlaygroundGroup = 'chat' | 'image' | 'embedding';

export const GROUP_LABELS: Record<PlaygroundGroup, string> = {
  chat: '对话',
  image: '图像',
  embedding: '向量',
};

/** operation → 分组；不在此表里的一律不进选择器 */
export const OPERATION_GROUPS: Record<string, PlaygroundGroup> = {
  chat: 'chat',
  responses: 'chat',
  messages: 'chat',
  'models.generate': 'chat',
  'images.generations': 'image',
  'images.edits': 'image',
  embeddings: 'embedding',
};

/** 本期只对这三种渲染真表单，其余降级为可执行 cURL */
export const SUPPORTED_OPERATIONS = new Set(['chat', 'images.generations', 'embeddings']);

export type PlaygroundOption = {
  modelId: string;
  displayName: string;
  operation: string;
  group: PlaygroundGroup;
  /** 是否有真实表单；false 表示只给 cURL */
  supported: boolean;
};

export type ClassifiedModels = Record<PlaygroundGroup, PlaygroundOption[]>;

export type ClassifyOptions = {
  /** 已开通模型白名单；空表示不限 */
  allowlist?: string[];
  /** 本次会话内被标记不可用（如 402）的模型 */
  blocked?: string[];
};

function isPlayable(model: CatalogModel): boolean {
  // catalog 不返回 status；admin 视角可能带，discontinued 的一律排除
  return model.status !== 'discontinued';
}

export function classifyModels(
  models: CatalogModel[],
  options: ClassifyOptions = {}
): ClassifiedModels {
  const allowlist = (options.allowlist ?? []).filter(Boolean);
  const blocked = new Set(options.blocked ?? []);
  const result: ClassifiedModels = { chat: [], image: [], embedding: [] };

  for (const model of models) {
    if (!isPlayable(model)) continue;
    if (blocked.has(model.id)) continue;
    if (allowlist.length > 0 && !allowlist.includes(model.id)) continue;

    const seen = new Set<string>();
    for (const inbound of model.inbound ?? []) {
      const operation = inbound?.operation;
      if (!operation || seen.has(operation)) continue;
      const group = OPERATION_GROUPS[operation];
      if (!group) continue;

      seen.add(operation);
      result[group].push({
        modelId: model.id,
        displayName: model.display_name || model.id,
        operation,
        group,
        supported: SUPPORTED_OPERATIONS.has(operation),
      });
    }
  }

  // 空分组直接不出现
  for (const group of Object.keys(result) as PlaygroundGroup[]) {
    if (result[group].length === 0) delete result[group];
  }
  return result;
}

/** 分组展开成扁平 option，便于「先选模型再选 operation」 */
export function flattenOptions(classified: ClassifiedModels): PlaygroundOption[] {
  return Object.values(classified).flat();
}
