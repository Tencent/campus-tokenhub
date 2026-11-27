/**
 * 表单 → 网关请求体。
 *
 * 只做「构造」，不发请求；调试台与代码片段共用同一份输出，避免两处漂移。
 * `advancedJson` 里的任何字段都覆盖表单值（厂商私有参数兜底）。
 */

import type { CatalogModel } from '@/lib/gateway/types';
import { imageFamily } from './model-params';

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type PlaygroundForm = {
  // 对话
  system?: string;
  messages?: ChatMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
  topP?: number | null;
  stream?: boolean;
  imageUrls?: string[];
  videoUrl?: string;
  // 图像
  prompt?: string;
  n?: number | null;
  responseFormat?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: string;
  negativePrompt?: string;
  // 向量
  input?: string;
  inputs?: string[];
};

export type BuildPayloadInput = {
  model: CatalogModel;
  operation: string;
  form: PlaygroundForm;
  advancedJson?: string;
};

export type BuiltPayload = {
  path: string;
  method: 'POST';
  body: Record<string, unknown>;
  /** true 表示该 operation 本期没有表单，只展示 cURL */
  unsupported: boolean;
};

export class PayloadError extends Error {
  readonly code: 'bad_advanced_json' | 'empty_input' | 'bad_advanced_shape';

  constructor(code: PayloadError['code'], message: string) {
    super(message);
    this.name = 'PayloadError';
    this.code = code;
  }
}

export const OPERATION_PATHS: Record<string, string> = {
  chat: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  'models.generate': '/v1/models/generate',
  'images.generations': '/v1/images/generations',
  'images.edits': '/v1/images/edits',
  embeddings: '/v1/embeddings',
};

export const DEFAULT_MAX_TOKENS = 1024;

function modalities(model: CatalogModel): string[] {
  return model.input_modalities ?? [];
}

function chatContent(model: CatalogModel, message: ChatMessage, form: PlaygroundForm): unknown {
  const supportsImage = modalities(model).includes('image');
  const supportsVideo = modalities(model).includes('video');

  const imageUrls = supportsImage ? (form.imageUrls ?? []).filter(Boolean) : [];
  const videoUrl = supportsVideo ? (form.videoUrl ?? '').trim() : '';

  if (imageUrls.length === 0 && !videoUrl) return message.content;

  return [
    { type: 'text', text: message.content },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ...(videoUrl ? [{ type: 'video_url', video_url: { url: videoUrl } }] : []),
  ];
}

function buildChat(model: CatalogModel, form: PlaygroundForm): Record<string, unknown> {
  const messages: { role: string; content: unknown }[] = [];
  const system = (form.system ?? '').trim();
  if (system) messages.push({ role: 'system', content: system });

  const rows = (form.messages ?? []).filter((row) => row.content.trim().length > 0);
  if (rows.length === 0) throw new PayloadError('empty_input', '请至少输入一条消息');

  for (const row of rows) {
    messages.push({ role: row.role, content: chatContent(model, row, form) });
  }

  const body: Record<string, unknown> = {
    model: model.id,
    messages,
    max_tokens: form.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: form.stream ?? false,
  };
  if (typeof form.temperature === 'number') body.temperature = form.temperature;
  if (typeof form.topP === 'number') body.top_p = form.topP;
  return body;
}

function buildImage(model: CatalogModel, form: PlaygroundForm): Record<string, unknown> {
  const prompt = (form.prompt ?? '').trim();
  if (!prompt) throw new PayloadError('empty_input', '请输入提示词');

  const body: Record<string, unknown> = { model: model.id, prompt };
  if (typeof form.n === 'number' && form.n > 0) body.n = form.n;
  if (form.responseFormat) body.response_format = form.responseFormat;

  const family = imageFamily(model.id);
  if (family === 'seedream') {
    if (form.size) body.size = form.size;
  } else if (family === 'kling') {
    if (form.aspectRatio) body.aspect_ratio = form.aspectRatio;
    if (form.resolution) body.resolution = form.resolution;
    if (form.negativePrompt) body.negative_prompt = form.negativePrompt;
  } else if (form.size) {
    body.size = form.size;
  }

  return body;
}

function buildEmbedding(model: CatalogModel, form: PlaygroundForm): Record<string, unknown> {
  const many = (form.inputs ?? []).map((item) => item.trim()).filter(Boolean);
  const single = (form.input ?? '').trim();

  if (many.length > 0) return { model: model.id, input: many };
  if (!single) throw new PayloadError('empty_input', '请输入要向量化的文本');
  return { model: model.id, input: single };
}

function mergeAdvanced(body: Record<string, unknown>, advancedJson?: string): Record<string, unknown> {
  const raw = (advancedJson ?? '').trim();
  if (!raw) return body;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PayloadError('bad_advanced_json', '高级参数不是合法 JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PayloadError('bad_advanced_shape', '高级参数必须是 JSON 对象');
  }

  // 高级参数优先：冲突时覆盖表单字段
  return { ...body, ...(parsed as Record<string, unknown>) };
}

export function buildPayload(input: BuildPayloadInput): BuiltPayload {
  const { model, operation, form, advancedJson } = input;
  const path = OPERATION_PATHS[operation];

  if (!path) throw new PayloadError('bad_advanced_shape', `未知的 operation：${operation}`);

  if (operation !== 'chat' && operation !== 'images.generations' && operation !== 'embeddings') {
    // responses / messages / models.generate / images.edits：本期不做表单
    return {
      path,
      method: 'POST',
      body: mergeAdvanced({ model: model.id }, advancedJson),
      unsupported: true,
    };
  }

  const base =
    operation === 'chat'
      ? buildChat(model, form)
      : operation === 'images.generations'
        ? buildImage(model, form)
        : buildEmbedding(model, form);

  return {
    path,
    method: 'POST',
    body: mergeAdvanced(base, advancedJson),
    unsupported: false,
  };
}
