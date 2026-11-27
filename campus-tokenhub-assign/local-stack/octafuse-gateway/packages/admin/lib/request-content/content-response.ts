/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文详情响应组装（纯函数）。
 *
 * 语义边界（spec「详情状态可区分」）：
 * - `captured`：有正文且未被截断；
 * - `truncated`：有正文，但 input 或 output 任一侧被截断（入库截断或本次响应裁剪）；
 * - `missing`：主表有日志但正文表没有行（未捕获 / 被丢弃 / 写入失败），
 *   与「日志本身不存在」的 404 明确区分。
 */
import type { RequestContentRow } from '@octafuse/core';

export type RequestContentState = 'captured' | 'truncated' | 'missing';

export type RequestContentResponse = {
	requestLogId: string;
	createdAt: string;
	state: RequestContentState;
	inputText: string | null;
	outputText: string | null;
	inputChars: number | null;
	outputChars: number | null;
	inputTruncated: boolean;
	outputTruncated: boolean;
};

const DEFAULT_MAX_CHARS = 65_536;

/** 与写入侧共用同一环境变量，避免「存了 64 KB、详情只给 8 KB」的不一致。 */
export function resolveResponseMaxChars(): number {
	const parsed = Number.parseInt(process.env.REQUEST_CONTENT_MAX_CHARS ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHARS;
}

/** 按 Unicode 码点裁剪，不切出孤立代理（与入库侧 `truncateByCodePoint` 同语义）。 */
function clip(text: string | null, maxChars: number): { text: string | null; truncated: boolean } {
	if (text == null) return { text: null, truncated: false };
	const codePoints = Array.from(text);
	if (codePoints.length <= maxChars) return { text, truncated: false };
	return { text: codePoints.slice(0, maxChars).join(''), truncated: true };
}

export function buildContentResponse(
	row: RequestContentRow | null,
	requestLogId: string,
	createdAt: string,
	maxChars: number = resolveResponseMaxChars()
): RequestContentResponse {
	if (!row) {
		return {
			requestLogId,
			createdAt,
			state: 'missing',
			inputText: null,
			outputText: null,
			inputChars: null,
			outputChars: null,
			inputTruncated: false,
			outputTruncated: false,
		};
	}

	const input = clip(row.input_text, maxChars);
	const output = clip(row.output_text, maxChars);
	const inputTruncated = row.input_truncated || input.truncated;
	const outputTruncated = row.output_truncated || output.truncated;

	return {
		requestLogId,
		createdAt,
		state: inputTruncated || outputTruncated ? 'truncated' : 'captured',
		inputText: input.text,
		outputText: output.text,
		inputChars: row.input_chars,
		outputChars: row.output_chars,
		inputTruncated,
		outputTruncated,
	};
}
