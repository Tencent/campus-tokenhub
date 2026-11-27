/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文字数限制与敏感大字段剥离。
 *
 * 两条硬约束（与 spec「单条内容超长」场景对齐）：
 * - 截断按 **Unicode 码点** 而不是 UTF-16 单元，避免把 emoji 切成孤立代理；
 * - 入库前剥离 data URL 与长 base64 串，防止图片/音频二进制挤占列宽。
 */

/** 单条 input / output 的默认上限（字符数，按码点计）。 */
export const DEFAULT_MAX_CONTENT_CHARS = 65_536;

/** 上游错误摘要的长度上限。 */
export const MAX_ERROR_TEXT_CHARS = 1024;

/**
 * 连续「疑似 base64」片段的最小长度。
 * 取 512 是为了放过正常的长英文/代码行，同时覆盖图片与音频的典型载荷。
 */
const BASE64_RUN_THRESHOLD = 512;

export type TruncateResult = {
	text: string;
	truncated: boolean;
};

export function truncateByCodePoint(text: string, maxChars: number): TruncateResult {
	if (!text) return { text: '', truncated: false };
	// 快速路径：UTF-16 长度不超过上限时，码点数必然也不超过
	if (text.length <= maxChars) return { text, truncated: false };

	const codePoints = Array.from(text);
	if (codePoints.length <= maxChars) return { text, truncated: false };

	return { text: codePoints.slice(0, maxChars).join(''), truncated: true };
}

/** 码点长度（emoji 计 1，而不是 2）。 */
export function codePointLength(text: string): number {
	return Array.from(text).length;
}

const DATA_URL_PATTERN = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=_\-\s]+/gi;
// base64 / base64url 的字符集（含 - _），阈值以上的连续片段才可能是二进制载荷
const LONG_BASE64_PATTERN = new RegExp(`[A-Za-z0-9+/_-]{${BASE64_RUN_THRESHOLD},}={0,2}`, 'g');

/**
 * 二进制载荷的启发式判据：同时含小写、大写与数字。
 * 纯大写 token（如长哈希、常量名）或纯小写长单词不会被误判。
 */
function looksLikeBinaryPayload(run: string): boolean {
	return /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9]/.test(run);
}

/**
 * 剥离 data URL 与长 base64 串，替换为 `[binary]` 占位。
 * 只针对「明显是二进制载荷」的片段，正常中文/英文文本不受影响。
 */
export function stripBase64(text: string): string {
	if (!text) return '';
	let result = text.replace(DATA_URL_PATTERN, '[binary]');
	result = result.replace(LONG_BASE64_PATTERN, (run) => (looksLikeBinaryPayload(run) ? '[binary]' : run));
	return result;
}

/** 单条上限的环境解析（clamp 到正数，非法值回落默认）。 */
export function resolveContentMaxChars(): number {
	const parsed = Number.parseInt(process.env.REQUEST_CONTENT_MAX_CHARS ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONTENT_CHARS;
}
