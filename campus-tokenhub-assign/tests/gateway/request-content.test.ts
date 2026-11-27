import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/lib/gateway/client';
import { PORTAL_CONTENT_MAX_CHARS, getOwnedRequestContent } from '@/lib/gateway/request-content';
import { fakeClient, wrap } from '../helpers/fake-client';

const logId = 'log-1';
const userId = 'gw-1';
const createdAt = '2026-11-18T13:48:52.680Z';

const row = {
	id: logId,
	user_id: userId,
	api_key_id: 'key-1',
	model_id: 'hy4',
	created_at: createdAt,
	status: 'success',
};

const contentBody = {
	requestLogId: logId,
	createdAt,
	state: 'captured' as const,
	inputText: 'user: 你好',
	outputText: '收到',
	inputChars: 8,
	outputChars: 2,
	inputTruncated: false,
	outputTruncated: false,
};

describe('getOwnedRequestContent', () => {
	it('按 id 精确取行；日志不存在时返回 null 且不请求正文', async () => {
		const client = fakeClient((call) => (call.path === '/api/admin/request-logs' ? wrap([]) : contentBody));

		await expect(getOwnedRequestContent(logId, userId, client)).resolves.toBeNull();
		expect(client.calls).toHaveLength(1);
		expect(client.calls[0].request?.query).toMatchObject({ id: logId, page_size: 1 });
	});

	it('网关返回的行 id 不匹配时返回 null，不请求正文', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([{ ...row, id: 'other-log' }]) : contentBody
		);

		await expect(getOwnedRequestContent(logId, userId, client)).resolves.toBeNull();
		expect(client.calls).toHaveLength(1);
	});

	it('日志属于其他用户时返回 null，不请求正文', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([{ ...row, user_id: 'gw-2' }]) : contentBody
		);

		await expect(getOwnedRequestContent(logId, userId, client)).resolves.toBeNull();
		expect(client.calls).toHaveLength(1);
	});

	it('归属成立时直接取正文，不再查用户列表或 Key', async () => {
		const client = fakeClient((call) => (call.path === '/api/admin/request-logs' ? wrap([row]) : contentBody));

		const result = await getOwnedRequestContent(logId, userId, client);

		expect(result).toEqual({
			state: 'captured',
			inputText: 'user: 你好',
			outputText: '收到',
			inputTruncated: false,
			outputTruncated: false,
		});
		expect(client.calls.map((call) => call.path)).toEqual([
			'/api/admin/request-logs',
			`/api/admin/request-logs/${logId}/content`,
		]);
	});

	it('Key 已删除不影响：只要日志行属于本人就能看', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([{ ...row, api_key_id: 'deleted-key' }]) : contentBody
		);

		const result = await getOwnedRequestContent(logId, userId, client);

		expect(result?.state).toBe('captured');
		expect(client.calls.some((call) => call.path.includes('/keys'))).toBe(false);
	});

	it('正文接口报错时抛出 GatewayError，不伪装成 null', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([row]) : new GatewayError('网关请求超时', 0, 'timeout')
		);

		await expect(getOwnedRequestContent(logId, userId, client)).rejects.toBeInstanceOf(GatewayError);
	});

	it('超过门户上限时按码点截断并把状态归为 truncated', async () => {
		const long = '汉'.repeat(PORTAL_CONTENT_MAX_CHARS + 10);
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([row]) : { ...contentBody, inputText: long }
		);

		const result = await getOwnedRequestContent(logId, userId, client);

		expect(result?.inputText?.length).toBe(PORTAL_CONTENT_MAX_CHARS);
		expect(result?.inputTruncated).toBe(true);
		expect(result?.outputTruncated).toBe(false);
		expect(result?.state).toBe('truncated');
	});

	it('网关侧截断标志会并入门户标志并升格为 truncated', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs' ? wrap([row]) : { ...contentBody, outputTruncated: true }
		);

		const result = await getOwnedRequestContent(logId, userId, client);

		expect(result?.outputTruncated).toBe(true);
		expect(result?.state).toBe('truncated');
	});

	it('missing 状态原样透传', async () => {
		const client = fakeClient((call) =>
			call.path === '/api/admin/request-logs'
				? wrap([row])
				: { ...contentBody, state: 'missing', inputText: null, outputText: null }
		);

		const result = await getOwnedRequestContent(logId, userId, client);

		expect(result).toEqual({
			state: 'missing',
			inputText: null,
			outputText: null,
			inputTruncated: false,
			outputTruncated: false,
		});
	});
});
