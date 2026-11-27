/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 浏览器根路径 API / 实时地址（3.2.1）。
 *
 * 约束（design D4/D6）：
 * - 浏览器请求统一经 `ADMIN_UI_PUBLIC_PATH` 前缀，根部署保持原样；
 * - 外部 URL 不改写；
 * - 实时通道使用 ws/wss 绝对地址并保留前缀与 query；
 * - Node 侧仍收到根 `/api/admin/*` 并重写为内部 `/admin/*`，CSRF 判定不依赖前缀。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAdminBrowserPaths } from './admin-browser-path';
import {
	PLAYGROUND_REALTIME_PATH,
	PLAYGROUND_REALTIME_PUBLIC_PATH,
	playgroundRealtimePublicUrl,
} from './playground-realtime-path';
import { isSameOriginBrowserWrite, rewriteToInternalAdminPath } from './admin-request-rewrite';

describe('browser public API paths', () => {
	it('keeps root deployments unchanged', () => {
		const paths = createAdminBrowserPaths('');
		assert.equal(paths.api('/api/auth/check'), '/api/auth/check');
		assert.equal(paths.asset('/brand/openai-emblem.svg'), '/brand/openai-emblem.svg');
	});

	it('maps API and asset requests under the public prefix once', () => {
		const paths = createAdminBrowserPaths('/tokenhub/admin');
		assert.equal(paths.api('/api/auth/check'), '/tokenhub/admin/api/auth/check');
		assert.equal(paths.api('/tokenhub/admin/api/auth/check'), '/tokenhub/admin/api/auth/check');
		assert.equal(
			paths.asset('/brand/openai-emblem.svg'),
			'/tokenhub/admin/brand/openai-emblem.svg',
		);
	});

	it('never rewrites external URLs', () => {
		const paths = createAdminBrowserPaths('/tokenhub/admin');
		assert.equal(paths.api('https://example.com/api/x'), 'https://example.com/api/x');
		assert.equal(paths.api('//cdn.example.com/x'), '//cdn.example.com/x');
	});
});

describe('playground realtime public URL', () => {
	it('serves the root realtime path at the deployed prefix', () => {
		assert.equal(PLAYGROUND_REALTIME_PATH, '/api/admin/playground/realtime');
		assert.equal(PLAYGROUND_REALTIME_PUBLIC_PATH, '/api/admin/playground/realtime');
		assert.equal(
			playgroundRealtimePublicUrl('https://ai.example.com', '/tokenhub/admin'),
			'wss://ai.example.com/tokenhub/admin/api/admin/playground/realtime',
		);
	});

	it('converts http(s) origins to ws(s) and keeps an existing ws origin', () => {
		assert.equal(
			playgroundRealtimePublicUrl('http://127.0.0.1:8789'),
			'ws://127.0.0.1:8789/api/admin/playground/realtime',
		);
		assert.equal(
			playgroundRealtimePublicUrl('wss://ai.example.com/'),
			'wss://ai.example.com/api/admin/playground/realtime',
		);
	});
});

describe('node-side root API contract is prefix-independent', () => {
	it('rewrites /api/admin/* to the internal Hono path and keeps the query', () => {
		const request = new Request('http://127.0.0.1:8789/api/admin/models?limit=5', {
			headers: { host: 'ai.example.com' },
		});
		const rewritten = rewriteToInternalAdminPath(request);
		const url = new URL(rewritten.url);
		assert.equal(url.pathname, '/admin/models');
		assert.equal(url.search, '?limit=5');
	});

	it('requires a same-origin Origin header for browser writes', () => {
		const sameOrigin = new Request('http://127.0.0.1:8789/api/admin/models', {
			method: 'POST',
			headers: { origin: 'https://ai.example.com', 'x-forwarded-host': 'ai.example.com', 'x-forwarded-proto': 'https' },
		});
		assert.equal(isSameOriginBrowserWrite(sameOrigin), true);

		const crossSite = new Request('http://127.0.0.1:8789/api/admin/models', {
			method: 'POST',
			headers: { origin: 'https://evil.example.com', 'x-forwarded-host': 'ai.example.com', 'x-forwarded-proto': 'https' },
		});
		assert.equal(isSameOriginBrowserWrite(crossSite), false);

		const missingOrigin = new Request('http://127.0.0.1:8789/api/admin/models', { method: 'POST' });
		assert.equal(isSameOriginBrowserWrite(missingOrigin), false);
	});
});
