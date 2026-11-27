/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 内容抽取：把客户端请求体、流式增量、非流式响应规范化为可留存文本。
 *
 * 设计约束（与 design.md D2 对齐）：
 * - 表驱动：`operation → 抽取器` 映射，新增协议只加一行；
 * - 只取文本：跳过 base64 / 图片 / 音频 part，跳过 tools 定义与采样参数；
 * - 纯函数：不依赖请求上下文与数据库，异常结构一律返回空串而不抛错。
 *
 * operation 取值来自各路由的 `requestOperation`；同一家族的不同变体
 * （如 `images.generations` 与 `images.generations.multimodal`）由 `opFamily` 归并，
 * 避免每新增一个多模态入口就要改矩阵。
 */
import type { CapturedContent } from '@octafuse/core';
import {
	codePointLength,
	DEFAULT_MAX_CONTENT_CHARS,
	MAX_ERROR_TEXT_CHARS,
	truncateByCodePoint,
} from './limits';

type RecordLike = Record<string, unknown>;

function asRecord(value: unknown): RecordLike | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordLike) : null;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function nonEmpty(value: unknown): string {
	return typeof value === 'string' && value.length > 0 ? value : '';
}

/** content 既可能是字符串，也可能是 part 数组；只收集文本 part。 */
function contentToText(content: unknown): string {
	if (typeof content === 'string') return content;
	const parts: string[] = [];
	for (const item of asArray(content)) {
		const part = asRecord(item);
		if (!part) continue;
		const text = nonEmpty(part.text);
		if (text) parts.push(text);
	}
	return parts.join('\n');
}

function messagesToText(messages: unknown): string {
	const lines: string[] = [];
	for (const item of asArray(messages)) {
		const record = asRecord(item);
		if (!record) continue;
		const role = nonEmpty(record.role) || 'unknown';
		const text = contentToText(record.content);
		if (text) lines.push(`${role}: ${text}`);
	}
	return lines.join('\n');
}

function geminiContentsToText(contents: unknown): string {
	const lines: string[] = [];
	for (const item of asArray(contents)) {
		const record = asRecord(item);
		if (!record) continue;
		const role = record.role === 'model' ? 'assistant' : nonEmpty(record.role) || 'user';
		const parts = asArray(record.parts)
			.map((part) => nonEmpty(asRecord(part)?.text))
			.filter(Boolean);
		if (parts.length > 0) lines.push(`${role}: ${parts.join('\n')}`);
	}
	return lines.join('\n');
}

function partsText(parts: unknown): string {
	return asArray(parts)
		.map((part) => nonEmpty(asRecord(part)?.text))
		.filter(Boolean)
		.join('\n');
}

/** operation → 协议家族；多模态等后缀变体按前缀归并。 */
export function opFamily(operation: string): string {
	if (operation === 'chat') return 'chat';
	if (operation === 'messages') return 'messages';
	if (operation === 'responses') return 'responses';
	if (operation === 'models.generate') return 'models.generate';
	return '';
}

type InputExtractor = (body: RecordLike) => string;

const INPUT_EXTRACTORS: Record<string, InputExtractor> = {
	chat: (body) => messagesToText(body.messages),
	messages: (body) => {
		const lines: string[] = [];
		// Anthropic 允许 system 为 string 或 TextBlockParam[]
		const system = typeof body.system === 'string' ? body.system : contentToText(body.system);
		if (system) lines.push(`system: ${system}`);
		const messages = messagesToText(body.messages);
		if (messages) lines.push(messages);
		return lines.join('\n');
	},
	responses: (body) => {
		const lines: string[] = [];
		const instructions = nonEmpty(body.instructions);
		if (instructions) lines.push(`instructions: ${instructions}`);
		if (typeof body.input === 'string') {
			if (body.input) lines.push(`user: ${body.input}`);
		} else if (Array.isArray(body.input)) {
			const messages = messagesToText(body.input);
			if (messages) lines.push(messages);
		}
		return lines.join('\n');
	},
	'models.generate': (body) => {
		const lines: string[] = [];
		// Gemini 的 systemInstruction 与 contents 平级
		const system = partsText(asRecord(body.systemInstruction)?.parts);
		if (system) lines.push(`system: ${system}`);
		const contents = geminiContentsToText(body.contents);
		if (contents) lines.push(contents);
		return lines.join('\n');
	},
};

export type ExtractRequestInputArgs = {
	operation: string;
	requestBody: unknown;
};

/** 流式捕获结果：driver 侧只产出 output 文本与截断标记，input 由请求体单独抽取。 */
export type StreamCapture = {
	text: string;
	chars: number;
	truncated: boolean;
};

/** 客户端请求体 → 规范化输入文本；未知 operation 返回空串。 */
export function extractRequestInput({ operation, requestBody }: ExtractRequestInputArgs): string {
	const extractor = INPUT_EXTRACTORS[opFamily(operation)];
	const body = asRecord(requestBody);
	if (!extractor || !body) return '';
	try {
		return extractor(body);
	} catch {
		return '';
	}
}

/** 流式单帧 → 本次新增的输出文本（无内容时返回空串）。 */
export function extractStreamDelta(operation: string, parsed: unknown): string {
	const frame = asRecord(parsed);
	if (!frame) return '';
	const family = opFamily(operation);
	try {
		switch (family) {
			case 'chat':
				return asArray(frame.choices)
					.map((choice) => nonEmpty(asRecord(asRecord(choice)?.delta)?.content))
					.join('');
			case 'messages': {
				if (frame.type !== 'content_block_delta') return '';
				return nonEmpty(asRecord(frame.delta)?.text);
			}
			case 'responses': {
				if (frame.type !== 'response.output_text.delta') return '';
				return nonEmpty(frame.delta);
			}
			case 'models.generate':
				return asArray(frame.candidates)
					.map((candidate) => partsText(asRecord(asRecord(candidate)?.content)?.parts))
					.filter(Boolean)
					.join('\n');
			default:
				return '';
		}
	} catch {
		return '';
	}
}

/** 非流式响应体 → 规范化输出文本。 */
export function extractResponseOutput(operation: string, payload: unknown): string {
	const body = asRecord(payload);
	if (!body) return '';
	const family = opFamily(operation);
	try {
		switch (family) {
			case 'chat':
				return asArray(body.choices)
					.map((choice) => contentToText(asRecord(asRecord(choice)?.message)?.content))
					.filter(Boolean)
					.join('\n');
			case 'messages':
				return asArray(body.content)
					.map((part) => nonEmpty(asRecord(part)?.text))
					.filter(Boolean)
					.join('\n');
			case 'responses':
				return asArray(body.output)
					.map((item) => partsText(asRecord(item)?.content))
					.filter(Boolean)
					.join('\n');
			case 'models.generate':
				return asArray(body.candidates)
					.map((candidate) => partsText(asRecord(asRecord(candidate)?.content)?.parts))
					.filter(Boolean)
					.join('\n');
			default:
				return '';
		}
	} catch {
		return '';
	}
}

/**
 * 上游错误体 → `type: message` 摘要（≤1 KB，按码点截断）。
 *
 * 覆盖四种真实形态：`{error:{type,message}}`、`{error:{message}}`、`{error:"..."}`、
 * `{message}` / `{detail}`，以及 Gemini 200 响应里的 `promptFeedback.blockReason`。
 */
export function buildUpstreamErrorText(payload: unknown): string {
	const body = asRecord(payload);
	if (!body) return '';

	const rawError = body.error;
	const error = asRecord(rawError);
	const type = nonEmpty(error?.type);
	const message =
		nonEmpty(error?.message) ||
		nonEmpty(rawError) ||
		nonEmpty(body.message) ||
		nonEmpty(body.detail);
	const blockReason = nonEmpty(asRecord(body.promptFeedback)?.blockReason);

	const text = type && message ? `${type}: ${message}` : type || message || blockReason;
	return truncateByCodePoint(text, MAX_ERROR_TEXT_CHARS).text;
}

export type BuildCapturedContentArgs = {
	operation: string;
	requestBody: unknown;
	outputText: string;
	/** 流式捕获已因超限或断连而截断 */
	outputTruncated?: boolean;
	maxChars?: number;
};

/**
 * 汇总为存储层所需的 `CapturedContent`（含字符数与两侧截断标记）。
 * 抽取层只负责文本；统一在这里做长度裁剪，避免调用方漏置标记。
 */
export function buildCapturedContent({
	operation,
	requestBody,
	outputText,
	outputTruncated,
	maxChars = DEFAULT_MAX_CONTENT_CHARS,
}: BuildCapturedContentArgs): CapturedContent {
	const input = truncateByCodePoint(
		extractRequestInput({ operation, requestBody }),
		maxChars
	);
	const output = truncateByCodePoint(outputText, maxChars);
	return {
		inputText: input.text,
		outputText: output.text,
		inputChars: codePointLength(input.text),
		outputChars: codePointLength(output.text),
		inputTruncated: input.truncated,
		outputTruncated: output.truncated || Boolean(outputTruncated),
	};
}

/**
 * 非流式响应正文 → `StreamCapture`。
 * 非法 JSON 或未知结构返回空文本，不抛错（响应本身已由 driver 重新包装给客户端）。
 */
export function captureFromBodyText(operation: string, bodyText: string | null): StreamCapture {
	const raw = bodyText?.trim() ?? '';
	if (!raw) return { text: '', chars: 0, truncated: false };
	let output = '';
	try {
		output = extractResponseOutput(operation, JSON.parse(raw) as unknown);
	} catch {
		return { text: '', chars: 0, truncated: false };
	}
	const cut = truncateByCodePoint(output, DEFAULT_MAX_CONTENT_CHARS);
	return { text: cut.text, chars: codePointLength(cut.text), truncated: cut.truncated };
}

/** 上游错误体（原始文本）→ ≤1 KB 摘要；非 JSON 按纯文本截断。 */
export function extractUpstreamError(bodyText: string | null): string {
	const raw = bodyText?.trim() ?? '';
	if (!raw) return '';
	try {
		const summary = buildUpstreamErrorText(JSON.parse(raw) as unknown);
		if (summary) return summary;
	} catch {
		// 非 JSON：按纯文本处理
	}
	return truncateByCodePoint(raw, MAX_ERROR_TEXT_CHARS).text;
}

/**
 * 上游非 2xx 响应 → 错误摘要捕获。
 * 调用方负责保证响应 body 尚未被消费（本函数内部 clone）。
 */
export function captureUpstreamErrorFromResponse(response: Response): Promise<StreamCapture> {
	return response
		.clone()
		.text()
		.then((text) => {
			const summary = extractUpstreamError(text);
			const cut = truncateByCodePoint(summary, MAX_ERROR_TEXT_CHARS);
			return { text: cut.text, chars: codePointLength(cut.text), truncated: cut.truncated };
		})
		.catch(() => ({ text: '', chars: 0, truncated: false }));
}
