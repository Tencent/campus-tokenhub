/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文详情响应的状态语义：captured / truncated / missing。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RequestContentRow } from '@octafuse/core';
import { buildContentResponse } from './content-response';

function row(overrides: Partial<RequestContentRow> = {}): RequestContentRow {
	return {
		request_log_id: 'log-1',
		created_at: '2026-11-18T10:00:00.000Z',
		user_id: 'u1',
		model_id: 'm1',
		request_protocol: 'openai',
		request_operation: 'chat',
		status: 'success',
		input_text: 'user: 你好',
		output_text: '你好，有什么可以帮你',
		input_chars: 9,
		output_chars: 9,
		input_truncated: false,
		output_truncated: false,
		schema_version: 1,
		...overrides,
	};
}

describe('buildContentResponse', () => {
	it('正常行返回 captured 与完整正文', () => {
		const result = buildContentResponse(row(), 'log-1', '2026-11-18T10:00:00.000Z');
		assert.equal(result.state, 'captured');
		assert.equal(result.inputText, 'user: 你好');
		assert.equal(result.outputText, '你好，有什么可以帮你');
		assert.equal(result.inputChars, 9);
	});

	it('任一侧被截断时状态为 truncated', () => {
		assert.equal(
			buildContentResponse(row({ output_truncated: true }), 'log-1', '2026-11-18T10:00:00.000Z').state,
			'truncated'
		);
		assert.equal(
			buildContentResponse(row({ input_truncated: true }), 'log-1', '2026-11-18T10:00:00.000Z').state,
			'truncated'
		);
	});

	it('正文行不存在时返回 missing，而不是 404 语义', () => {
		const result = buildContentResponse(null, 'log-2', '2026-11-18T10:00:00.000Z');
		assert.equal(result.state, 'missing');
		assert.equal(result.inputText, null);
		assert.equal(result.outputText, null);
	});

	it('返回体按上限裁剪，避免详情页撑爆', () => {
		const result = buildContentResponse(
			row({ input_text: 'x'.repeat(200) }),
			'log-1',
			'2026-11-18T10:00:00.000Z',
			50
		);
		assert.equal(result.inputText?.length, 50);
	});
});
