/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台公网路径边界（2.1.1 红测基线）。
 *
 * 约束（design D4 / spec「browser public paths are distinct from service route paths」）：
 * - `ADMIN_UI_PUBLIC_PATH` 只影响前端（Vite base、Router basename、浏览器请求）；
 * - 空前缀（本地/根路径部署）必须可用；
 * - 非法配置（协议、host、query、hash、`..`、非根相对）必须被拒绝；
 * - 已经是本站前缀的路径不得重复补前缀；第三方 URL 不得被改写；
 * - query/hash 在拼接中保留。
 *
 * 本模块是纯函数，不得导入 React、Next、Node 文件系统或任何 secret。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	ADMIN_UI_PUBLIC_PATH_ENV,
	createAdminPublicPath,
	joinAdminPublicPath,
	normalizeAdminUiPublicPath,
} from './admin-public-path';

describe('normalizeAdminUiPublicPath', () => {
	it('accepts an empty prefix for root deployments', () => {
		assert.equal(normalizeAdminUiPublicPath(undefined), '');
		assert.equal(normalizeAdminUiPublicPath(''), '');
		assert.equal(normalizeAdminUiPublicPath('   '), '');
	});

	it('keeps a root-relative pathname and strips the trailing slash', () => {
		assert.equal(normalizeAdminUiPublicPath('/tokenhub/admin'), '/tokenhub/admin');
		assert.equal(normalizeAdminUiPublicPath('/tokenhub/admin/'), '/tokenhub/admin');
		assert.equal(normalizeAdminUiPublicPath('  /tokenhub/admin/  '), '/tokenhub/admin');
	});

	it('rejects values that are not a bare root-relative pathname', () => {
		const invalid = [
			'tokenhub/admin',
			'//evil.example.com/admin',
			'https://api.aiedu.tencent.com/tokenhub/admin',
			'/tokenhub/admin?tab=keys',
			'/tokenhub/admin#top',
			'/tokenhub/admin/../secret',
			'/tokenhub//admin',
			'/tokenhub/admin\\..\\secret',
			'/tokenhub admin',
		];
		for (const value of invalid) {
			assert.throws(
				() => normalizeAdminUiPublicPath(value),
				/ADMIN_UI_PUBLIC_PATH/,
				`expected rejection for ${JSON.stringify(value)}`,
			);
		}
	});

	it('rejects a bare slash as the public path', () => {
		assert.throws(() => normalizeAdminUiPublicPath('/'), /ADMIN_UI_PUBLIC_PATH/);
	});

	it('exposes the environment variable name used by build and runtime', () => {
		assert.equal(ADMIN_UI_PUBLIC_PATH_ENV, 'ADMIN_UI_PUBLIC_PATH');
	});
});

describe('joinAdminPublicPath', () => {
	it('returns local paths unchanged when no prefix is configured', () => {
		assert.equal(joinAdminPublicPath('', '/api/admin/stats'), '/api/admin/stats');
		assert.equal(joinAdminPublicPath('', '/dashboard?tab=keys'), '/dashboard?tab=keys');
	});

	it('prefixes site paths once', () => {
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin', '/api/admin/stats'),
			'/tokenhub/admin/api/admin/stats',
		);
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin', '/assets/app-abc123.js'),
			'/tokenhub/admin/assets/app-abc123.js',
		);
	});

	it('never prefixes the same base twice', () => {
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin', '/tokenhub/admin/api/admin/stats'),
			'/tokenhub/admin/api/admin/stats',
		);
		assert.equal(joinAdminPublicPath('/tokenhub/admin', '/tokenhub/admin'), '/tokenhub/admin');
	});

	it('does not treat a similar name as an existing prefix', () => {
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin', '/tokenhub/administrator/x'),
			'/tokenhub/admin/tokenhub/administrator/x',
		);
	});

	it('normalizes a trailing slash on the base instead of creating a double slash', () => {
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin/', '/ui-version.json'),
			'/tokenhub/admin/ui-version.json',
		);
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin/', '/tokenhub/admin/api/admin/stats'),
			'/tokenhub/admin/api/admin/stats',
		);
		assert.equal(joinAdminPublicPath('/', '/ui-version.json'), '/ui-version.json');
	});

	it('preserves query and hash', () => {
		assert.equal(
			joinAdminPublicPath('/tokenhub/admin', '/api/admin/playground/realtime?model=x#frag'),
			'/tokenhub/admin/api/admin/playground/realtime?model=x#frag',
		);
	});

	it('leaves external and protocol-relative URLs untouched', () => {
		const external = [
			'https://api.example.com/v1/models',
			'http://127.0.0.1:8789/health',
			'//cdn.example.com/app.js',
			'mailto:ops@example.com',
			'data:text/plain,hi',
		];
		for (const url of external) {
			assert.equal(joinAdminPublicPath('/tokenhub/admin', url), url);
		}
	});
});

describe('createAdminPublicPath', () => {
	it('derives the router basename and vite base', () => {
		const root = createAdminPublicPath('');
		assert.equal(root.base, '');
		assert.equal(root.routerBasename, '/');
		assert.equal(root.viteBase, '/');

		const prefixed = createAdminPublicPath('/tokenhub/admin/');
		assert.equal(prefixed.base, '/tokenhub/admin');
		assert.equal(prefixed.routerBasename, '/tokenhub/admin');
		assert.equal(prefixed.viteBase, '/tokenhub/admin/');
	});

	it('builds browser API, asset and websocket paths under the prefix', () => {
		const prefix = createAdminPublicPath('/tokenhub/admin');
		assert.equal(prefix.api('/api/admin/models'), '/tokenhub/admin/api/admin/models');
		assert.equal(prefix.asset('/brand/openai-emblem.svg'), '/tokenhub/admin/brand/openai-emblem.svg');
		assert.equal(
			prefix.wsUrl('wss://api.aiedu.tencent.com', '/api/admin/playground/realtime?model=x'),
			'wss://api.aiedu.tencent.com/tokenhub/admin/api/admin/playground/realtime?model=x',
		);
	});

	it('keeps websocket URLs usable at the domain root', () => {
		const root = createAdminPublicPath('');
		assert.equal(
			root.wsUrl('ws://127.0.0.1:8789', '/api/admin/playground/realtime'),
			'ws://127.0.0.1:8789/api/admin/playground/realtime',
		);
	});

	it('rejects invalid configuration at construction time', () => {
		assert.throws(() => createAdminPublicPath('https://evil.example.com'), /ADMIN_UI_PUBLIC_PATH/);
	});
});
