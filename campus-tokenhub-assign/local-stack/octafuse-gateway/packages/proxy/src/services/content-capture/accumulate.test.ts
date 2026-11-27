/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 流式正文累积器与长度限制。
 *
 * 关注三件事：
 * - 多个 delta 拼接后与完整文本一致（含代理对被拆到两个 delta 的情况）；
 * - 超过上限时按 Unicode 码点截断，不产生半个 emoji；
 * - 大段 base64 / data URL 被剥离，不进入正文。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createCaptureAccumulator } from './accumulate';
import { stripBase64, truncateByCodePoint } from './limits';

describe('truncateByCodePoint', () => {
	it('未超限时原样返回', () => {
		assert.deepEqual(truncateByCodePoint('abc', 10), { text: 'abc', truncated: false });
	});

	it('按码点而不是 UTF-16 单元截断', () => {
		const emoji = '👨👩👧';
		const result = truncateByCodePoint(emoji, 2);
		assert.equal(result.truncated, true);
		assert.equal(result.text, '👨👩');
		assert.equal(result.text.length, 4);
	});

	it('不会切出孤立代理', () => {
		const result = truncateByCodePoint('a👨b', 2);
		assert.equal(result.text, 'a👨');
	});
});

describe('stripBase64', () => {
	it('移除 data URL 与长 base64 串', () => {
		const longBase64 = 'Ab3'.repeat(200);
		const text = stripBase64(`前文 data:image/png;base64,${longBase64} 后文 ${longBase64}`);
		assert.doesNotMatch(text, /base64/);
		assert.doesNotMatch(text, /Ab3/);
		assert.match(text, /前文/);
		assert.match(text, /后文/);
	});

	it('正常长英文串不被误剥离', () => {
		const lower = 'a'.repeat(600);
		const upper = 'A'.repeat(600);
		assert.equal(stripBase64(lower), lower);
		assert.equal(stripBase64(upper), upper);
	});

	it('普通文本不受影响', () => {
		assert.equal(stripBase64('这是一段正常的中文'), '这是一段正常的中文');
	});
});

describe('createCaptureAccumulator', () => {
	it('多个 delta 拼接后与完整文本一致', () => {
		const acc = createCaptureAccumulator();
		acc.append('你好');
		acc.append('，世界');
		acc.append('！');
		const result = acc.finish();
		assert.equal(result.text, '你好，世界！');
		assert.equal(result.chars, 6);
		assert.equal(result.truncated, false);
	});

	it('代理对被拆到两个 delta 时仍能还原', () => {
		const acc = createCaptureAccumulator();
		acc.append('\uD83D');
		acc.append('\uDC68');
		const result = acc.finish();
		assert.equal(result.text, '👨');
	});

	it('超过上限时截断并标记 truncated，且不产生孤立代理', () => {
		const acc = createCaptureAccumulator(4);
		acc.append('ab');
		acc.append('👨');
		acc.append('cd');
		const result = acc.finish();
		assert.equal(result.truncated, true);
		assert.equal(result.chars, 4);
		assert.equal(result.text, 'ab👨c');
	});

	it('截断后继续 append 不再增长', () => {
		const acc = createCaptureAccumulator(2);
		acc.append('ab');
		acc.append('cd');
		acc.append('ef');
		const result = acc.finish();
		assert.equal(result.text, 'ab');
		assert.equal(result.truncated, true);
	});

	it('finish 时剥离 base64', () => {
		const acc = createCaptureAccumulator();
		acc.append('结果：');
		acc.append(`data:image/png;base64,${'Ab3'.repeat(200)}`);
		acc.append('完成');
		const result = acc.finish();
		assert.doesNotMatch(result.text, /base64/);
		assert.match(result.text, /结果：/);
		assert.match(result.text, /完成/);
	});

	it('finish 可重复调用且结果一致', () => {
		const acc = createCaptureAccumulator();
		acc.append('内容');
		assert.deepEqual(acc.finish(), acc.finish());
	});

	it('空 append 不改变状态', () => {
		const acc = createCaptureAccumulator();
		acc.append('');
		acc.append(undefined as unknown as string);
		const result = acc.finish();
		assert.equal(result.text, '');
		assert.equal(result.chars, 0);
		assert.equal(result.truncated, false);
	});
});
