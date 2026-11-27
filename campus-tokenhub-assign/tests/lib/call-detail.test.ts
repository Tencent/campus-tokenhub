import { describe, expect, it } from 'vitest';
import {
	MAX_PARAM_CHARS,
	formatLatency,
	formatParamsJson,
	parseRequestParams,
	resolveContentBlocks,
	summarizeCallInput,
	summarizeParamLine,
	type CallContent,
} from '@/lib/portal/call-detail';

function body(value: Record<string, unknown>): string {
	return JSON.stringify(value);
}

describe('parseRequestParams', () => {
	it('解析对象型 JSON', () => {
		expect(parseRequestParams(body({ model: 'm-1', stream: true }))).toEqual({ model: 'm-1', stream: true });
	});

	it('空值、非法 JSON、数组都返回 null', () => {
		expect(parseRequestParams(null)).toBeNull();
		expect(parseRequestParams('   ')).toBeNull();
		expect(parseRequestParams('{oops')).toBeNull();
		expect(parseRequestParams('[1,2,3]')).toBeNull();
	});
});

describe('summarizeCallInput', () => {
	it('从脱敏请求体读出消息条数、角色、工具与流式标记', () => {
		const summary = summarizeCallInput(
			body({
				model: 'm-1',
				stream: true,
				_messages_count: 4,
				_messages_shape: {
					system: ['content'],
					user: ['content'],
					assistant: ['content', 'tool_calls'],
					content_types: { user: ['text', 'image_url'] },
				},
				_tool_names: ['search', 'search', 'calc'],
				_tools_count: 2,
			})
		);

		expect(summary.messagesCount).toBe(4);
		expect(summary.roles).toEqual(['system', 'user', 'assistant']);
		expect(summary.contentTypes).toEqual(['text', 'image_url']);
		expect(summary.toolNames).toEqual(['search', 'calc']);
		expect(summary.stream).toBe(true);
		expect(summary.preview).toBe('消息 4 条 · system / user / assistant · 工具 2 个 · 流式');
	});

	it('没有消息摘要时退回参数项数', () => {
		const summary = summarizeCallInput(body({ model: 'm-1', temperature: 0.2, max_tokens: 128 }));
		expect(summary.messagesCount).toBeNull();
		expect(summary.roles).toEqual([]);
		expect(summary.preview).toBe('请求参数 3 项');
	});

	it('缺请求体时给出明确占位', () => {
		const summary = summarizeCallInput(null);
		expect(summary.params).toBeNull();
		expect(summary.preview).toBe('本次调用未记录请求参数');
	});
});

describe('summarizeParamLine', () => {
	it('按固定顺序拼出白名单字段', () => {
		const line = summarizeParamLine(
			body({
				model: 'hy4',
				temperature: 0.7,
				top_p: 0.9,
				max_tokens: 2048,
				stream: true,
				n: 2,
				seed: 42,
			})
		);

		expect(line).toBe('model=hy4 temperature=0.7 top_p=0.9 max_tokens=2048 stream=true n=2 seed=42');
	});

	it('消息正文与未知字段都不出现在输出里', () => {
		const line = summarizeParamLine(
			body({
				model: 'hy4',
				messages: [{ role: 'user', content: '这段正文不应出现' }],
				input: '也不应出现',
				prompt: '不应出现',
				data: '不应出现',
				custom_flag: 'x',
			})
		);

		expect(line).toBe('model=hy4');
		expect(line).not.toContain('这段正文');
		expect(line).not.toContain('custom_flag');
	});

	it('非法 JSON 返回固定文案且不回显原文', () => {
		expect(summarizeParamLine('{oops "messages": [')).toBe('请求参数无法解析');
		expect(summarizeParamLine('{"messages": [')).not.toContain('messages');
	});

	it('空值与无可用字段给出占位文案', () => {
		expect(summarizeParamLine(null)).toBe('本次调用未记录请求参数');
		expect(summarizeParamLine('  ')).toBe('本次调用未记录请求参数');
		expect(summarizeParamLine(body({ messages: [], temperature: undefined }))).toBe('本次调用未记录请求参数');
	});
});

describe('resolveContentBlocks', () => {
	const captured = (over: Partial<CallContent> = {}): CallContent => ({
		state: 'captured',
		inputText: 'user: 你好',
		outputText: '收到',
		inputTruncated: false,
		outputTruncated: false,
		...over,
	});

	it('已捕获且未截断时直接展示正文', () => {
		const blocks = resolveContentBlocks(captured());
		expect(blocks.input).toEqual({ kind: 'text', text: 'user: 你好', truncated: false });
		expect(blocks.output).toEqual({ kind: 'text', text: '收到', truncated: false });
	});

	it('任一侧被截断时该侧标记 truncated', () => {
		const blocks = resolveContentBlocks(captured({ outputTruncated: true }));
		expect(blocks.input.truncated).toBe(false);
		expect(blocks.output.truncated).toBe(true);
	});

	it('未开启留存时两侧都是占位文案', () => {
		const blocks = resolveContentBlocks({ ...captured(), state: 'missing', inputText: null, outputText: null });
		expect(blocks.input).toEqual({ kind: 'placeholder', text: '学校未开启内容留存', truncated: false });
		expect(blocks.output).toEqual({ kind: 'placeholder', text: '学校未开启内容留存', truncated: false });
	});

	it('已捕获但某侧正文为空时给出未记录提示', () => {
		const blocks = resolveContentBlocks(captured({ inputText: '', outputText: null }));
		expect(blocks.input).toEqual({ kind: 'placeholder', text: '本次调用未记录输入内容', truncated: false });
		expect(blocks.output).toEqual({ kind: 'placeholder', text: '本次调用未记录输出内容', truncated: false });
	});

	it('请求失败时两侧都是失败占位，且优先级高于 missing', () => {
		const blocks = resolveContentBlocks(null, { failed: true });
		expect(blocks.input).toEqual({ kind: 'placeholder', text: '正文读取失败', truncated: false });
		expect(blocks.output).toEqual({ kind: 'placeholder', text: '正文读取失败', truncated: false });
	});
});

describe('formatParamsJson', () => {
	it('按缩进 JSON 输出，未超长不截断', () => {
		const text = formatParamsJson({ model: 'm-1' });
		expect(text).toContain('"model": "m-1"');
		expect(text).not.toContain('已截断');
	});

	it('超过上限时截断并标注总长度', () => {
		const long = formatParamsJson({ note: 'x'.repeat(200) }, 60);
		expect(long.length).toBeLessThan(120);
		expect(long).toContain('已截断');
		expect(MAX_PARAM_CHARS).toBeGreaterThan(500);
	});

	it('没有参数时返回占位文案', () => {
		expect(formatParamsJson(null)).toBe('本次调用未记录请求参数');
	});
});

describe('formatLatency', () => {
	it('毫秒与秒两种量级分别显示', () => {
		expect(formatLatency(860)).toBe('860 ms');
		expect(formatLatency(1500)).toBe('1.5 s');
		expect(formatLatency(12_400)).toBe('12 s');
	});

	it('空值显示占位符', () => {
		expect(formatLatency(null)).toBe('—');
		expect(formatLatency(Number.NaN)).toBe('—');
	});
});
