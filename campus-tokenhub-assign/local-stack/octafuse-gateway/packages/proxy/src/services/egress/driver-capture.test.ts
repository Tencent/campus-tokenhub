/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * driver 层正文捕获的接入约束：
 * - `onFrame` 只观察已解析的帧，不改变原有解析结果与终止判定；
 * - 累积结果等于所有 delta 文本的拼接。
 *
 * 字节级一致性由实现顺序保证（`onFrame` 在 `forward` 拼接之前调用，
 * 且不修改 line/parsed），既有 driver 转发测试（85 例）作为回归基线。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EMPTY_USAGE } from '../proxy';
import { createCaptureAccumulator } from '../content-capture/accumulate';
import { captureFromBodyText, extractStreamDelta } from '../content-capture/extract';
import { processResponsesDataLine } from './openai-responses-driver';

const FRAMES = [
	'data: {"type":"response.output_text.delta","delta":"你"}',
	'data: {"type":"response.output_text.delta","delta":"好"}',
	'data: {"type":"response.completed"}',
];

describe('driver 正文捕获', () => {
	it('onFrame 不改变解析结果与终止判定', () => {
		const acc = createCaptureAccumulator();
		const withFrame = FRAMES.map((line) =>
			processResponsesDataLine(line, { ...EMPTY_USAGE }, undefined, (parsed) => {
				const delta = extractStreamDelta('responses', parsed);
				if (delta) acc.append(delta);
			})
		);
		const withoutFrame = FRAMES.map((line) =>
			processResponsesDataLine(line, { ...EMPTY_USAGE }, undefined)
		);

		assert.deepEqual(withFrame, withoutFrame);
		assert.equal(acc.finish().text, '你好');
	});

	it('未配置 onFrame 时不产生任何副作用', () => {
		const results = FRAMES.map((line) => processResponsesDataLine(line, { ...EMPTY_USAGE }));
		assert.deepEqual(results, [false, false, true]);
	});
});

describe('非流式正文捕获', () => {
	it('JSON 响应体可抽出输出文本', () => {
		const capture = captureFromBodyText(
			'chat',
			JSON.stringify({ choices: [{ message: { content: '答案是 42' } }] })
		);
		assert.equal(capture.text, '答案是 42');
		assert.equal(capture.truncated, false);
	});

	it('非 JSON 或空响应体返回空正文，不抛错', () => {
		assert.deepEqual(captureFromBodyText('chat', 'not-json'), { text: '', chars: 0, truncated: false });
		assert.deepEqual(captureFromBodyText('chat', null), { text: '', chars: 0, truncated: false });
	});
});
