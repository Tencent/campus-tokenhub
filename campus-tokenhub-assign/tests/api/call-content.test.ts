import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';
import { GatewayError } from '@/lib/gateway/client';

const mocks = vi.hoisted(() => ({
  getOwnedRequestContent: vi.fn(),
}));

vi.mock('@/lib/gateway/request-content', () => ({
  getOwnedRequestContent: mocks.getOwnedRequestContent,
}));

import { GET } from '@/app/api/portal/calls/[id]/content/route';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Gateway-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

const identity = { sub: 'student-1', email: 'a@school.edu', name: '张三' };

async function buildRequest(octafuseUserId: string | null = 'gw-1'): Promise<Request> {
	const token = await signSession({ ...identity, octafuseUserId });
	return new Request('http://portal.test/api/portal/calls/log-1/content', {
		method: 'GET',
		headers: { cookie: `portal_session=${token}`, host: 'portal.test' },
	});
}

async function call(octafuseUserId: string | null = 'gw-1') {
	const request = await buildRequest(octafuseUserId);
	return GET(request, { params: Promise.resolve({ id: 'log-1' }) });
}

beforeEach(() => {
	Object.assign(process.env, baseEnv);
	resetConfigCache();
	vi.clearAllMocks();
	mocks.getOwnedRequestContent.mockResolvedValue({
		state: 'captured',
		inputText: 'user: 你好',
		outputText: '收到',
		inputTruncated: false,
		outputTruncated: false,
	});
});

describe('GET /api/portal/calls/[id]/content', () => {
	it('无会话返回 401，且不查网关', async () => {
		const request = new Request('http://portal.test/api/portal/calls/log-1/content', { method: 'GET' });
		const response = await GET(request, { params: Promise.resolve({ id: 'log-1' }) });

		expect(response.status).toBe(401);
		expect(mocks.getOwnedRequestContent).not.toHaveBeenCalled();
	});

	it('已登录但未开户返回 409', async () => {
		const response = await call(null);

		expect(response.status).toBe(409);
		expect(mocks.getOwnedRequestContent).not.toHaveBeenCalled();
	});

	it('日志不存在或不属于本人时返回 404', async () => {
		mocks.getOwnedRequestContent.mockResolvedValue(null);

		const response = await call();

		expect(response.status).toBe(404);
		await expect(response.json()).resolves.toMatchObject({ code: 'not_found' });
	});

	it('命中时返回状态、两侧正文与截断标志，并禁止缓存', async () => {
		const response = await call();

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		await expect(response.json()).resolves.toEqual({
			state: 'captured',
			inputText: 'user: 你好',
			outputText: '收到',
			inputTruncated: false,
			outputTruncated: false,
		});
		expect(mocks.getOwnedRequestContent).toHaveBeenCalledWith('log-1', 'gw-1');
	});

	it('网关不可用时返回 502，与「不属于本人」区分', async () => {
		mocks.getOwnedRequestContent.mockRejectedValue(new GatewayError('网关请求超时', 0, 'timeout'));

		const response = await call();

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({ code: 'gateway_unavailable' });
	});

	it('其它异常返回 500 而不是抛出', async () => {
		mocks.getOwnedRequestContent.mockRejectedValue(new Error('boom'));

		const response = await call();

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({ code: 'internal_error' });
	});

	it('非法 id 直接 400，不查网关', async () => {
		const request = await buildRequest();
		const response = await GET(request, { params: Promise.resolve({ id: '../../etc/passwd' }) });

		expect(response.status).toBe(400);
		expect(mocks.getOwnedRequestContent).not.toHaveBeenCalled();
	});
});
