/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Node 侧 UI 调度边界（1.2.1 红测基线，3.1 扩展静态/版本元数据边界）。
 *
 * 约束（design D2/D3/D5）：
 * - `/api/**` 永远先于静态与 UI 页面交回 Next；
 * - UI 根文件与 hashed 资源走显式清单，缺失必须 404，禁止任意文件与 index.html fallback；
 * - `/ui-version.json` 必须 `application/json` + `no-store`，缺失时返回明确错误而非 HTML；
 * - 只有纯数据 route manifest 命中的页面才返回 UI HTML；
 * - 其余路径交给 Next，由 Next 返回它自己的 404；
 * - Node dispatch 的模块图不得引入 React / React Router / ui 适配器。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import * as esbuild from 'esbuild';
import { dispatchAdminUiRequest } from './admin-ui-dispatch';
import { ADMIN_UI_ROUTES, matchAdminUiRoute } from './admin-ui-route-manifest';

const HERE = dirname(fileURLToPath(import.meta.url));
const UI_DIST_TEMPLATE = '<!doctype html><html><body><div id="root"></div></body></html>';

let root = '';
let uiDistDir = '';
let publicDir = '';
let noMetadataUiDist = '';

function request(method: string, pathname: string) {
	return dispatchAdminUiRequest({ method, pathname, uiDistDir, publicDir });
}

before(() => {
	root = mkdtempSync(join(tmpdir(), 'admin-ui-dispatch-'));
	uiDistDir = join(root, 'ui-dist');
	publicDir = join(root, 'public');
	noMetadataUiDist = join(root, 'ui-dist-no-metadata');
	mkdirSync(join(uiDistDir, 'assets'), { recursive: true });
	mkdirSync(join(uiDistDir, '.vite'), { recursive: true });
	mkdirSync(join(noMetadataUiDist, 'assets'), { recursive: true });
	mkdirSync(join(publicDir, 'brand'), { recursive: true });
	writeFileSync(join(uiDistDir, 'index.html'), UI_DIST_TEMPLATE);
	writeFileSync(join(uiDistDir, 'ui-version.json'), '{"buildId":"test-build"}');
	writeFileSync(join(uiDistDir, '.vite', 'manifest.json'), '{"src":"../app/dashboard/page.tsx"}');
	writeFileSync(join(uiDistDir, 'assets', 'app-abc123.js'), 'console.log("ui")');
	writeFileSync(join(uiDistDir, 'assets', 'app-abc123.css'), '.x{color:red}');
	writeFileSync(join(noMetadataUiDist, 'index.html'), UI_DIST_TEMPLATE);
	writeFileSync(join(noMetadataUiDist, 'assets', 'app-abc123.js'), 'console.log("ui")');
	writeFileSync(join(publicDir, 'brand', 'openai-emblem.svg'), '<svg></svg>');
	writeFileSync(join(root, 'secret.txt'), 'top-secret');
});

after(() => {
	rmSync(root, { recursive: true, force: true });
});

describe('admin UI route manifest', () => {
	it('covers the full admin route manifest including redirects', () => {
		const pageIds = ADMIN_UI_ROUTES.filter((route) => route.kind === 'page').map((route) => route.id);
		assert.deepEqual(pageIds, [
			'dashboard',
			'providers',
			'models',
			'routes',
			'playground',
			'simulator',
			'users',
			'user-detail',
			'keys',
			'request-logs',
			'audit-logs',
			'tools',
			'mcp',
			'tool-invocations',
			'analytics-models',
			'analytics-providers',
			'analytics-users',
			'analytics-reliability',
			'admin-api-keys',
			'config',
		]);
		const rootRoute = ADMIN_UI_ROUTES.find((route) => route.id === 'root');
		assert.equal(rootRoute?.kind, 'redirect');
		assert.equal(rootRoute?.redirectTo, '/dashboard');
		const legacy = ADMIN_UI_ROUTES.find((route) => route.id === 'legacy-oauth-access-tokens');
		assert.equal(legacy?.redirectTo, '/gateway/mcp#oauth-access-tokens');
		// 维护模式已并入配置页：旧地址必须留在清单里，否则书签会落到 Next 的 404
		const legacyMaintenance = ADMIN_UI_ROUTES.find((route) => route.id === 'legacy-maintenance');
		assert.equal(legacyMaintenance?.kind, 'redirect');
		assert.equal(legacyMaintenance?.redirectTo, '/gateway/config#config-panel-maintenance');
	});

	it('matches legacy maintenance redirect', () => {
		assert.equal(matchAdminUiRoute('/gateway/maintenance')?.route.id, 'legacy-maintenance');
	});

	it('matches dashboard and dynamic user detail with params', () => {
		assert.equal(matchAdminUiRoute('/dashboard')?.route.id, 'dashboard');
		const detail = matchAdminUiRoute('/gateway/users/u-1');
		assert.equal(detail?.route.id, 'user-detail');
		assert.deepEqual(detail?.params, { id: 'u-1' });
	});

	it('does not match API, asset, unknown or deeper dynamic paths', () => {
		assert.equal(matchAdminUiRoute('/api/admin/stats'), null);
		assert.equal(matchAdminUiRoute('/assets/app-abc123.js'), null);
		assert.equal(matchAdminUiRoute('/gateway/users/u-1/extra'), null);
		assert.equal(matchAdminUiRoute('/gateway/not-a-page'), null);
	});
});

describe('dispatchAdminUiRequest', () => {
	it('keeps every /api request on the Next handler, before UI matching', () => {
		assert.equal(request('GET', '/api/auth/check').kind, 'next-api');
		assert.equal(request('POST', '/api/auth/login').kind, 'next-api');
		assert.equal(request('POST', '/api/admin/models').kind, 'next-api');
		assert.equal(request('GET', '/api/does-not-exist').kind, 'next-api');
		// `/api/dashboard` 不能被 UI 页面规则吞掉。
		assert.equal(request('GET', '/api/dashboard').kind, 'next-api');
	});

	it('serves UI HTML for manifest pages, including the dynamic detail', () => {
		const dashboard = request('GET', '/dashboard');
		assert.equal(dashboard.kind, 'ui-html');
		const detail = request('GET', '/gateway/users/u-1');
		assert.equal(detail.kind, 'ui-html');
		const rootEntry = request('GET', '/');
		assert.equal(rootEntry.kind, 'ui-html');
	});

	it('serves hashed assets and public files with correct content types', () => {
		const js = request('GET', '/assets/app-abc123.js');
		assert.equal(js.kind, 'static');
		assert.match(js.kind === 'static' ? js.contentType : '', /javascript/);
		const css = request('GET', '/assets/app-abc123.css');
		assert.match(css.kind === 'static' ? css.contentType : '', /text\/css/);
		const svg = request('GET', '/brand/openai-emblem.svg');
		assert.equal(svg.kind, 'static');
		assert.match(svg.kind === 'static' ? svg.contentType : '', /image\/svg\+xml/);
	});

	it('returns 404 for missing assets/public files instead of index.html', () => {
		assert.equal(request('GET', '/assets/missing-xyz.js').kind, 'not-found');
		assert.equal(request('GET', '/brand/missing-logo.svg').kind, 'not-found');
	});

	it('serves the SPA entry without caching', () => {
		const entry = request('GET', '/index.html');
		assert.equal(entry.kind, 'static');
		assert.equal(entry.kind === 'static' ? entry.cacheControl : '', 'no-store');
	});

	it('serves UI version metadata as uncached JSON', () => {
		const metadata = request('GET', '/ui-version.json');
		assert.equal(metadata.kind, 'static');
		assert.equal(metadata.kind === 'static' ? metadata.contentType : '', 'application/json; charset=utf-8');
		assert.equal(metadata.kind === 'static' ? metadata.cacheControl : '', 'no-store');
		assert.equal(request('HEAD', '/ui-version.json').kind, 'static');
		assert.equal(request('POST', '/ui-version.json').kind, 'method-not-allowed');
	});

	it('returns an explicit error instead of HTML when version metadata is missing', () => {
		const result = dispatchAdminUiRequest({
			method: 'GET',
			pathname: '/ui-version.json',
			uiDistDir: noMetadataUiDist,
			publicDir,
		});
		assert.equal(result.kind, 'not-found');
		assert.match(result.kind === 'not-found' ? result.message : '', /version metadata/i);
	});

	it('never serves Vite build internals such as the source manifest', () => {
		assert.equal(request('GET', '/.vite/manifest.json').kind, 'not-found');
		assert.equal(request('GET', '/.vite/').kind, 'not-found');
	});

	it('rejects encoded dot segments before any file lookup', () => {
		assert.equal(request('GET', '/brand/%2e%2e/ui-version.json').kind, 'not-found');
		assert.equal(request('GET', '/assets/%2e%2e%2fsecret.txt').kind, 'not-found');
		assert.equal(request('GET', '/a\\..\\secret.txt').kind, 'not-found');
	});

	it('hands Next build assets and internal paths to Next instead of 404', () => {
		// 未迁移页面仍由 Next 渲染，`/_next/**` 被静态兜底拦下会导致页面白屏。
		assert.equal(request('GET', '/_next/static/chunks/main-app-abc.js').kind, 'next-page');
		assert.equal(request('GET', '/_next/static/css/app.css').kind, 'next-page');
		assert.equal(request('GET', '/_next/image').kind, 'next-page');
	});

	it('rejects directory traversal without reading outside roots', () => {
		assert.equal(request('GET', '/assets/%2e%2e/%2e%2e/secret.txt').kind, 'not-found');
		assert.equal(request('GET', '/assets/../../secret.txt').kind, 'not-found');
	});

	it('lets unknown paths fall through to Next, which owns its own 404', () => {
		assert.equal(request('GET', '/gateway/not-a-page').kind, 'next-page');
		assert.equal(request('GET', '/does-not-exist').kind, 'next-page');
		assert.equal(request('GET', '/gateway/users/u-1/extra').kind, 'next-page');
	});

	it('treats HEAD like GET for static and page resources', () => {
		assert.equal(request('HEAD', '/dashboard').kind, 'ui-html');
		assert.equal(request('HEAD', '/assets/app-abc123.js').kind, 'static');
	});

	it('returns 405 for non-read methods on UI and assets', () => {
		const page = request('POST', '/dashboard');
		assert.equal(page.kind, 'method-not-allowed');
		assert.equal(page.kind === 'method-not-allowed' ? page.allow : '', 'GET, HEAD');
		assert.equal(request('PUT', '/assets/app-abc123.js').kind, 'method-not-allowed');
	});

	it('leaves non-read methods on unknown paths to Next', () => {
		// UI 页面与非 /api 的未知路径：前者 405，后者交 Next 自行判定。
		assert.equal(request('POST', '/gateway/models').kind, 'method-not-allowed');
		assert.equal(request('POST', '/gateway/not-a-page').kind, 'next-page');
		assert.equal(request('POST', '/does-not-exist').kind, 'next-page');
	});
});

describe('Node matcher parity with the manifest', () => {
	it('serves every manifest route as SPA HTML', () => {
		for (const route of ADMIN_UI_ROUTES) {
			const sample = route.pattern.replace(':id', 'u-1');
			assert.ok(matchAdminUiRoute(sample), `route ${route.id} should match itself`);
			assert.equal(request('GET', sample).kind, 'ui-html', `route ${route.id} (${sample})`);
		}
	});
});

describe('Node dispatch module graph', () => {
	it('does not import React, React Router or the browser route adapter', async () => {
		const result = await esbuild.build({
			entryPoints: [resolve(HERE, 'admin-ui-dispatch.ts')],
			bundle: true,
			platform: 'node',
			format: 'esm',
			write: false,
			metafile: true,
			logLevel: 'silent',
		});
		const inputs = Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/'));
		const forbidden = inputs.filter(
			(path) =>
				/(^|\/)node_modules\/(react|react-dom|react-router|react-router-dom)\//.test(path) ||
				/(^|\/)ui\/(routes|App|main|link|navigation)\.(tsx?|jsx?)$/.test(path),
		);
		assert.deepEqual(forbidden, []);
	});
});
