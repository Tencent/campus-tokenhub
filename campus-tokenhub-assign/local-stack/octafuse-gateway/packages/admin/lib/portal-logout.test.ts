/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户登出代理的边界（design D6 / spec「一次登出同时失效门户与管理台」）。
 *
 * 关键点：
 * - 门户登出是 POST，且会 303：`redirect: 'manual'` 才能拿到 Set-Cookie；
 * - 3xx 属正常结果，不得判为失败；
 * - 门户 5xx / 超时必须返回 `ok:false`，调用方不得声称已退出；
 * - 未配置 `PORTAL_LOGOUT_URL` 时只清管理台会话（`skipped`）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { proxyPortalLogout } from './portal-logout';

const LOGOUT_URL = 'https://api.test/tokenhub/portal/api/auth/logout';

describe('proxyPortalLogout', () => {
	it('带原始 Cookie 头 POST，并透传门户的 Set-Cookie', async () => {
		let seen: { url: string; init?: RequestInit } | null = null;
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			seen = { url, init };
			return new Response('', {
				status: 303,
				headers: {
					location: 'https://api.test/tokenhub/portal/login',
					'set-cookie': 'portal_session=; Path=/; Max-Age=0',
				},
			});
		}) as unknown as typeof fetch;

		const result = await proxyPortalLogout({
			logoutUrl: LOGOUT_URL,
			cookieHeader: 'portal_session=abc',
			fetchImpl,
		});

		assert.equal(result.ok, true);
		if (result.ok) assert.deepEqual(result.setCookies, ['portal_session=; Path=/; Max-Age=0']);
		assert.equal(seen!.url, LOGOUT_URL);
		assert.equal(seen!.init?.method, 'POST');
		assert.equal(seen!.init?.redirect, 'manual');
		assert.equal((seen!.init?.headers as Record<string, string>).cookie, 'portal_session=abc');
	});

	it('门户 5xx 时返回失败，不谎报已退出', async () => {
		const fetchImpl = (async () => new Response('boom', { status: 502 })) as unknown as typeof fetch;

		const result = await proxyPortalLogout({ logoutUrl: LOGOUT_URL, fetchImpl });

		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /502/);
	});

	it('超时返回失败（带可读提示）', async () => {
		const fetchImpl = ((_url: string, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => {
					const error = new Error('aborted');
					error.name = 'AbortError';
					reject(error);
				});
			})) as unknown as typeof fetch;

		const result = await proxyPortalLogout({ logoutUrl: LOGOUT_URL, fetchImpl, timeoutMs: 10 });

		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.message, /超时/);
	});

	it('未配置地址时跳过（仅退出管理台）', async () => {
		const result = await proxyPortalLogout({ logoutUrl: '', fetchImpl: (() => {
			throw new Error('should not fetch');
		}) as unknown as typeof fetch });

		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.skipped, true);
	});
});
