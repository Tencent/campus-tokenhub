/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 流式正文累积器。
 *
 * 为什么不用字符串 `+=`：一次响应可能上千个 delta，反复拼接会产生大量中间字符串；
 * 这里先 push 到数组、结束时一次 join，超限时才整体截断一次（也保证代理对已还原）。
 *
 * 上限检查在 append 侧就生效：超过上限后不再接收新内容，避免异常长响应把内存拉高。
 */
import {
	codePointLength,
	DEFAULT_MAX_CONTENT_CHARS,
	stripBase64,
	truncateByCodePoint,
} from './limits';

export type CaptureAccumulatorResult = {
	text: string;
	/** 入库字符数（按码点，已剥离 base64） */
	chars: number;
	truncated: boolean;
};

export type CaptureAccumulator = {
	append(delta: string): void;
	finish(): CaptureAccumulatorResult;
	/** 当前累计码点数（不做剥离，仅用于调试与日志） */
	size(): number;
};

export function createCaptureAccumulator(
	maxChars: number = DEFAULT_MAX_CONTENT_CHARS
): CaptureAccumulator {
	let parts: string[] = [];
	let chars = 0;
	let truncated = false;

	return {
		append(delta: string): void {
			if (!delta || truncated) return;

			parts.push(delta);
			// 先用 UTF-16 长度做廉价预算；只有越过上限才做一次精确的码点截断，
			// 这样 emoji 不会被多算导致提前截断（精确判断交给 truncateByCodePoint）。
			chars += delta.length;

			if (chars > maxChars) {
				const merged = parts.join('');
				const cut = truncateByCodePoint(merged, maxChars);
				if (!cut.truncated) {
					// 实际码点数未超限（emoji 让 UTF-16 预算偏大），继续接收
					chars = codePointLength(merged);
					return;
				}
				parts = [cut.text];
				chars = codePointLength(cut.text);
				truncated = true;
			}
		},

		finish(): CaptureAccumulatorResult {
			const cleaned = stripBase64(parts.join(''));
			return { text: cleaned, chars: codePointLength(cleaned), truncated };
		},

		size(): number {
			return chars;
		},
	};
}
