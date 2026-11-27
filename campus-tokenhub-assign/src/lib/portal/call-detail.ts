/**
 * 对话明细的纯展示计算。
 *
 * 网关写入 `api_key_request_logs.request_body` 的是脱敏后的请求体：消息正文被剔除，
 * 只留 `_messages_count` / `_messages_shape` / `_tool_names` 这类结构摘要。
 * 这里把这些摘要折算成「输入侧」可读文案，供明细行折叠态与展开态复用。
 */

/** 展开态请求参数的最大展示长度：单行日志 16KB 会撑爆页面 */
export const MAX_PARAM_CHARS = 1600;

export type CallInputSummary = {
	/** 解析后的脱敏请求参数；无法解析时为 null */
	params: Record<string, unknown> | null;
	messagesCount: number | null;
	/** 出现过的消息角色，按首次出现顺序 */
	roles: string[];
	/** content 数组里出现过的 part 类型 */
	contentTypes: string[];
	toolNames: string[];
	stream: boolean | null;
	/** 折叠态一行摘要 */
	preview: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

export function parseRequestParams(raw: string | null | undefined): Record<string, unknown> | null {
	if (!raw?.trim()) return null;
	try {
		return asRecord(JSON.parse(raw) as unknown);
	} catch {
		return null;
	}
}

export function summarizeCallInput(raw: string | null | undefined): CallInputSummary {
	const params = parseRequestParams(raw);
	if (!params) {
		return {
			params: null,
			messagesCount: null,
			roles: [],
			contentTypes: [],
			toolNames: [],
			stream: null,
			preview: raw?.trim() ? '请求参数无法解析' : '本次调用未记录请求参数',
		};
	}

	const messagesCount = typeof params._messages_count === 'number' ? params._messages_count : null;
	const shape = asRecord(params._messages_shape);
	const roles = shape ? Object.keys(shape).filter((key) => key !== 'content_types') : [];
	const contentTypes = shape
		? unique(
				Object.values(asRecord(shape.content_types) ?? {})
					.map(toStringArray)
					.flat()
			)
		: [];
	const toolNames = unique(toStringArray(params._tool_names));
	const stream = typeof params.stream === 'boolean' ? params.stream : null;

	const parts: string[] = [];
	if (messagesCount !== null) parts.push(`消息 ${messagesCount} 条`);
	else if (roles.length > 0) parts.push(`消息 ${roles.length} 类`);
	if (roles.length > 0) parts.push(roles.join(' / '));
	if (toolNames.length > 0) parts.push(`工具 ${toolNames.length} 个`);
	if (stream) parts.push('流式');

	return {
		params,
		messagesCount,
		roles,
		contentTypes,
		toolNames,
		stream,
		preview: parts.length > 0 ? parts.join(' · ') : `请求参数 ${Object.keys(params).length} 项`,
	};
}

/** 展开态展示用：格式化 JSON 并按字符截断，避免长参数撑破页面 */
export function formatParamsJson(params: Record<string, unknown> | null, maxChars = MAX_PARAM_CHARS): string {
	if (!params) return '本次调用未记录请求参数';
	let text: string;
	try {
		text = JSON.stringify(params, null, 2) ?? '';
	} catch {
		return '请求参数无法序列化';
	}
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… 已截断（共 ${text.length} 字符）`;
}

/**
 * 单行参数摘要的字段白名单，顺序即展示顺序。
 *
 * 只取这几个顶层标量：`messages` / `input` / `prompt` / `data` 这类正文即使被网关漏脱敏，
 * 也不会进到抽屉里。
 */
const PARAM_LINE_FIELDS = [
	'model',
	'temperature',
	'top_p',
	'max_tokens',
	'stream',
	'n',
	'size',
	'aspect_ratio',
	'resolution',
	'seed',
] as const;

/** 单行摘要里每个值的展示上限：异常长的字段值不能撑破一行 */
export const MAX_PARAM_VALUE_CHARS = 200;

/** 标量才能进单行摘要：对象/数组/空串一律跳过 */
function scalarText(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (trimmed === '') return null;
	const points = Array.from(trimmed);
	return points.length > MAX_PARAM_VALUE_CHARS
		? `${points.slice(0, MAX_PARAM_VALUE_CHARS).join('')}…`
		: trimmed;
}

/** 设计稿 `7:536` 的单行参数：`model=… temperature=… max_tokens=… stream=true` */
export function summarizeParamLine(raw: string | null | undefined): string {
	const params = parseRequestParams(raw);
	if (!params) return raw?.trim() ? '请求参数无法解析' : '本次调用未记录请求参数';

	const parts = PARAM_LINE_FIELDS.flatMap((field) => {
		const text = scalarText(params[field]);
		return text === null ? [] : [`${field}=${text}`];
	});

	return parts.length > 0 ? parts.join(' ') : '本次调用未记录请求参数';
}

/** 门户正文接口的响应契约（与 `lib/gateway/request-content` 对齐） */
export type CallContent = {
	state: 'captured' | 'truncated' | 'missing';
	inputText: string | null;
	outputText: string | null;
	inputTruncated: boolean;
	outputTruncated: boolean;
};

export type ContentBlock = {
	kind: 'text' | 'placeholder';
	text: string;
	/** 该侧内容被截断（网关侧或门户侧），展示时加提示 */
	truncated: boolean;
};

function placeholder(text: string): ContentBlock {
	return { kind: 'placeholder', text, truncated: false };
}

function toBlock(text: string | null, truncated: boolean | undefined, emptyText: string): ContentBlock {
	const trimmed = text?.trim();
	if (!trimmed) return placeholder(emptyText);
	return { kind: 'text', text: trimmed, truncated: Boolean(truncated) };
}

/**
 * 抽屉输入/输出两栏的渲染数据。
 *
 * 优先级：请求失败 > 未开启留存 > 正常正文（含截断标记）。
 * 非流式调用只捕获输入，输出为空串，这里给出「未记录」而不是空白块。
 */
export function resolveContentBlocks(
	content: CallContent | null,
	options: { failed?: boolean } = {}
): { input: ContentBlock; output: ContentBlock } {
	if (options.failed) {
		return { input: placeholder('正文读取失败'), output: placeholder('正文读取失败') };
	}
	if (!content || content.state === 'missing') {
		return { input: placeholder('学校未开启内容留存'), output: placeholder('学校未开启内容留存') };
	}
	return {
		input: toBlock(content.inputText, content.inputTruncated, '本次调用未记录输入内容'),
		output: toBlock(content.outputText, content.outputTruncated, '本次调用未记录输出内容'),
	};
}

/** 耗时：毫秒以内按 ms，超过 1 秒按秒显示一位小数 */
export function formatLatency(ms: number | null | undefined): string {
	if (ms == null || !Number.isFinite(ms)) return '—';
	if (ms < 1000) return `${Math.round(ms)} ms`;
	return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}
