/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 内容抽取：4 个 LLM 协议的输入、流式增量、非流式响应与上游错误摘要。
 *
 * 这些是纯函数，不依赖请求上下文与数据库；断言只看「抽出来的文本」，不看实现细节。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	buildCapturedContent,
	extractRequestInput,
	extractResponseOutput,
	extractStreamDelta,
	buildUpstreamErrorText,
} from './extract';

describe('extractRequestInput：LLM 协议', () => {
	it('OpenAI Chat：string 与多模态 part 都能抽取，剔除 tools/采样参数/base64', () => {
		const text = extractRequestInput({
			protocol: 'openai',
			operation: 'chat',
			requestBody: {
				model: 'gpt-x',
				temperature: 0.7,
				tools: [{ type: 'function', function: { name: 'search' } }],
				messages: [
					{ role: 'system', content: '你是学习助手' },
					{ role: 'user', content: '什么是勾股定理' },
					{
						role: 'assistant',
						content: [
							{ type: 'text', text: '直角三角形的性质' },
							{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
						],
					},
				],
			},
		});

		assert.match(text, /system: 你是学习助手/);
		assert.match(text, /user: 什么是勾股定理/);
		assert.match(text, /assistant: 直角三角形的性质/);
		assert.doesNotMatch(text, /base64/);
		assert.doesNotMatch(text, /temperature/);
		assert.doesNotMatch(text, /search/);
	});

	it('Anthropic Messages：system 顶层字段 + messages content', () => {
		const text = extractRequestInput({
			protocol: 'anthropic',
			operation: 'messages',
			requestBody: {
				system: '只回答数学问题',
				messages: [{ role: 'user', content: [{ type: 'text', text: '解方程 x+1=2' }] }],
			},
		});

		assert.match(text, /system: 只回答数学问题/);
		assert.match(text, /user: 解方程 x\+1=2/);
	});

	it('Responses：instructions + input 字符串', () => {
		const text = extractRequestInput({
			protocol: 'openai',
			operation: 'responses',
			requestBody: { instructions: '简洁回答', input: '地球到月球多远' },
		});

		assert.match(text, /instructions: 简洁回答/);
		assert.match(text, /user: 地球到月球多远/);
	});

	it('Gemini：contents[].parts[].text', () => {
		const text = extractRequestInput({
			protocol: 'gemini',
			operation: 'models.generate',
			requestBody: {
				contents: [
					{ role: 'user', parts: [{ text: '讲个笑话' }, { text: '要短的' }] },
					{ role: 'model', parts: [{ text: '为什么...' }] },
				],
			},
		});

		assert.match(text, /user: 讲个笑话\n要短的/);
		assert.match(text, /assistant: 为什么/);
	});

	it('Anthropic Messages：system 为 block 数组时也要抽取', () => {
		const text = extractRequestInput({
			protocol: 'anthropic',
			operation: 'messages',
			requestBody: {
				system: [{ type: 'text', text: '只回答数学问题' }],
				messages: [{ role: 'user', content: 'x+1=2' }],
			},
		});
		assert.match(text, /system: 只回答数学问题/);
	});

	it('Gemini：systemInstruction 与 contents 一起抽取', () => {
		const text = extractRequestInput({
			protocol: 'gemini',
			operation: 'models.generate',
			requestBody: {
				systemInstruction: { parts: [{ text: '你是物理老师' }] },
				contents: [{ role: 'user', parts: [{ text: '重力加速度' }] }],
			},
		});
		assert.match(text, /system: 你是物理老师/);
		assert.match(text, /user: 重力加速度/);
	});

	it('Responses：input 为消息数组时同样抽取', () => {
		const text = extractRequestInput({
			protocol: 'openai',
			operation: 'responses',
			requestBody: {
				input: [
					{ role: 'user', content: [{ type: 'input_text', text: '解释浮力' }] },
					{ role: 'assistant', content: [{ type: 'output_text', text: '浮力等于...' }] },
				],
			},
		});
		assert.match(text, /user: 解释浮力/);
		assert.match(text, /assistant: 浮力等于/);
	});

	it('未知 operation 返回空串而不是抛错', () => {
		const text = extractRequestInput({
			protocol: 'openai',
			operation: 'unknown.op',
			requestBody: { messages: [{ role: 'user', content: 'hi' }] },
		});
		assert.equal(text, '');
	});
});

describe('extractStreamDelta：流式增量', () => {
	it('Chat 取 delta.content，忽略 reasoning_content', () => {
		assert.equal(extractStreamDelta('chat', { choices: [{ delta: { content: '你' } }] }), '你');
		assert.equal(
			extractStreamDelta('chat', { choices: [{ delta: { reasoning_content: '思考中' } }] }),
			''
		);
	});

	it('Messages 取 content_block_delta.text', () => {
		assert.equal(
			extractStreamDelta('messages', { type: 'content_block_delta', delta: { type: 'text_delta', text: '好' } }),
			'好'
		);
	});

	it('Responses 取 output_text.delta', () => {
		assert.equal(
			extractStreamDelta('responses', { type: 'response.output_text.delta', delta: '的' }),
			'的'
		);
		assert.equal(
			extractStreamDelta('responses', { type: 'response.reasoning_text.delta', delta: '想' }),
			''
		);
	});

	it('Gemini 取 candidates[].content.parts[].text', () => {
		assert.equal(
			extractStreamDelta('models.generate', {
				candidates: [{ content: { parts: [{ text: '世' }] } }],
			}),
			'世'
		);
	});

	it('结构异常时返回空串，不抛错', () => {
		assert.equal(extractStreamDelta('chat', {}), '');
		assert.equal(extractStreamDelta('chat', null), '');
		assert.equal(extractStreamDelta('messages', { delta: { type: 'thinking_delta', thinking: 'x' } }), '');
	});
});

describe('extractResponseOutput：非流式响应', () => {
	it('Chat：choices[0].message.content', () => {
		assert.equal(
			extractResponseOutput('chat', { choices: [{ message: { content: '答案' } }] }),
			'答案'
		);
	});

	it('Messages：content[].text 拼接', () => {
		assert.equal(
			extractResponseOutput('messages', {
				content: [
					{ type: 'text', text: '第一段' },
					{ type: 'text', text: '第二段' },
				],
			}),
			'第一段\n第二段'
		);
	});

	it('Responses：output[].content[].text 拼接', () => {
		assert.equal(
			extractResponseOutput('responses', {
				output: [{ content: [{ type: 'output_text', text: '输出' }] }],
			}),
			'输出'
		);
	});

	it('Gemini：candidates[].content.parts[].text', () => {
		assert.equal(
			extractResponseOutput('models.generate', {
				candidates: [{ content: { parts: [{ text: '甲' }, { text: '乙' }] } }],
			}),
			'甲\n乙'
		);
	});
});

describe('buildUpstreamErrorText：上游错误摘要', () => {
	it('取 error.type 与 error.message', () => {
		const text = buildUpstreamErrorText({ error: { type: 'invalid_request_error', message: 'messages 过长' } });
		assert.equal(text, 'invalid_request_error: messages 过长');
	});

	it('只有 message 时直接返回，并截断到 1 KB', () => {
		const text = buildUpstreamErrorText({ error: { message: 'x'.repeat(5000) } });
		assert.equal(text.length, 1024);
		assert.match(text, /^x+$/);
	});

	it('无 error 字段时取顶层 message，仍无则空串', () => {
		assert.equal(buildUpstreamErrorText({ message: '服务不可用' }), '服务不可用');
		assert.equal(buildUpstreamErrorText({}), '');
		assert.equal(buildUpstreamErrorText(null), '');
	});

	it('兼容 error 为字符串与 detail 字段', () => {
		assert.equal(buildUpstreamErrorText({ error: 'quota exceeded' }), 'quota exceeded');
		assert.equal(buildUpstreamErrorText({ detail: 'Not Found' }), 'Not Found');
	});

	it('Gemini 200 响应里的 blockReason 也能作为拒答摘要', () => {
		assert.equal(
			buildUpstreamErrorText({ promptFeedback: { blockReason: 'SAFETY' } }),
			'SAFETY'
		);
	});

	it('按码点截断，不切出孤立代理', () => {
		const text = buildUpstreamErrorText({ error: { message: '👨'.repeat(2000) } });
		assert.equal(text.length, 2048);
		assert.doesNotMatch(text, /[\uD800-\uDBFF]$/);
	});
});

describe('buildCapturedContent：统一裁剪与标记', () => {
	it('未超限时两侧标记均为 false，字符数按码点', () => {
		const content = buildCapturedContent({
			operation: 'chat',
			requestBody: { messages: [{ role: 'user', content: '你好👨' }] },
			outputText: '好的',
		});
		assert.equal(content.inputText, 'user: 你好👨');
		assert.equal(content.inputChars, 9);
		assert.equal(content.outputChars, 2);
		assert.equal(content.inputTruncated, false);
		assert.equal(content.outputTruncated, false);
	});

	it('input 超限时只标记 inputTruncated', () => {
		const content = buildCapturedContent({
			operation: 'chat',
			requestBody: { messages: [{ role: 'user', content: 'x'.repeat(50) }] },
			outputText: '短',
			maxChars: 10,
		});
		assert.equal(content.inputChars, 10);
		assert.equal(content.inputTruncated, true);
		assert.equal(content.outputTruncated, false);
	});

	it('流式已截断时 outputTruncated 透传', () => {
		const content = buildCapturedContent({
			operation: 'chat',
			requestBody: {},
			outputText: '部分',
			outputTruncated: true,
		});
		assert.equal(content.outputTruncated, true);
	});
});
