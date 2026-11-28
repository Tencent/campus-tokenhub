/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `verify:production`：从全新镜像隔离启动实际 Node 入口，验证同端口 UI + 根 API。
 *
 * 设计约束（tasks 1.2.4 / design D7/D8）：
 * - 不挂载宿主源码或 node_modules；只用 `docker run <全新 tag>`；
 * - 使用独立临时网络、临时 postgres（tmpfs）与随机宿主端口，不触碰现有容器；
 * - 断言 `/dashboard`、`/gateway/users/:id`、`/assets/*`、`/brand/*`、登录 Cookie、
 *   受保护 API、未知 API、locale 与 405/404；仅静态 shell 200 不算通过。
 *
 * 环境变量：
 * - `ADMIN_VERIFY_IMAGE`（默认 `octafuse-admin:verify-local`）
 * - `ADMIN_VERIFY_SKIP_BUILD=1`：复用已有镜像，不重新 build
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_ROOT = join(__dirname, '..');
const WORKSPACE_ROOT = join(ADMIN_ROOT, '../..');
const IMAGE = process.env.ADMIN_VERIFY_IMAGE?.trim() || 'octafuse-admin:verify-local';
const SKIP_BUILD = process.env.ADMIN_VERIFY_SKIP_BUILD === '1';
const ADMIN_USERNAME = 'admin';
// 一次性临时容器的随机口令，不来自也不写入任何真实凭证。
const ADMIN_PASSWORD = `verify-${randomUUID()}`;
const DB_USER = 'octafuse';
const DB_PASSWORD = `verify-${randomUUID()}`;
const DB_NAME = 'octafuse';
const POSTGRES_IMAGE = process.env.ADMIN_VERIFY_POSTGRES_IMAGE?.trim() || 'postgres:16-alpine';
const BOOT_TIMEOUT_MS = 180_000;
const POLL_MS = 500;

const suffix = `${Date.now()}-${process.pid}`;
const networkName = `octafuse-admin-verify-net-${suffix}`;
const postgresName = `octafuse-admin-verify-pg-${suffix}`;
const adminName = `octafuse-admin-verify-app-${suffix}`;

const results = [];
let adminPort = 0;
const containerLogs = { admin: '', postgres: '' };

function log(message) {
	console.log(`[admin/verify-production] ${message}`);
}

function fail(message) {
	throw new Error(message);
}

function docker(args, options = {}) {
	const result = spawnSync('docker', args, {
		encoding: 'utf8',
		stdio: options.inherit ? 'inherit' : 'pipe',
		...options,
	});
	if (result.status !== 0) {
		const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
		fail(`docker ${args.join(' ')} failed (exit ${result.status})${stderr ? `: ${stderr}` : ''}`);
	}
	return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = createNetServer();
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
		server.on('error', reject);
	});
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(label, check, timeoutMs = BOOT_TIMEOUT_MS) {
	const startedAt = Date.now();
	let lastError = '';
	while (Date.now() - startedAt < timeoutMs) {
		try {
			const value = await check();
			if (value) return value;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(POLL_MS);
	}
	fail(`${label} timed out after ${timeoutMs}ms${lastError ? ` (last error: ${lastError})` : ''}`);
}

function collectLogs() {
	for (const [key, name] of [
		['admin', adminName],
		['postgres', postgresName],
	]) {
		try {
			containerLogs[key] = execFileSync('docker', ['logs', '--tail', '200', name], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			containerLogs[key] = `failed to read logs: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

async function record(name, check) {
	const detail = await check();
	results.push({ name, detail });
	log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function baseUrl() {
	return `http://127.0.0.1:${adminPort}`;
}

function assert(condition, message) {
	if (!condition) fail(message);
}

function headerIncludes(response, name, expected) {
	const value = response.headers.get(name) ?? '';
	return value.toLowerCase().includes(expected.toLowerCase());
}

async function main() {
	if (!SKIP_BUILD) {
		log(`building ${IMAGE} from ${WORKSPACE_ROOT}/Dockerfile.admin`);
		docker(
			['build', '--progress=plain', '-f', 'Dockerfile.admin', '-t', IMAGE, '.'],
			{ cwd: WORKSPACE_ROOT, inherit: true },
		);
	} else {
		log(`reusing ${IMAGE} (ADMIN_VERIFY_SKIP_BUILD=1)`);
	}

	docker(['image', 'inspect', IMAGE]);
	adminPort = await getFreePort();
	log(`isolated port 127.0.0.1:${adminPort} -> 8789`);

	docker(['network', 'create', networkName]);
	log(`network ${networkName}`);

	docker([
		'run',
		'-d',
		'--name',
		postgresName,
		'--network',
		networkName,
		'--tmpfs',
		'/var/lib/postgresql/data',
		'-e',
		`POSTGRES_USER=${DB_USER}`,
		'-e',
		`POSTGRES_PASSWORD=${DB_PASSWORD}`,
		'-e',
		`POSTGRES_DB=${DB_NAME}`,
		POSTGRES_IMAGE,
	]);
	log(`postgres ${postgresName} (${POSTGRES_IMAGE})`);

	await waitFor('postgres readiness', () => {
		const status = spawnSync(
			'docker',
			['exec', postgresName, 'pg_isready', '-U', DB_USER, '-d', DB_NAME],
			{ encoding: 'utf8' },
		);
		return status.status === 0;
	}, 60_000);
	log('postgres ready');

	docker([
		'run',
		'-d',
		'--name',
		adminName,
		'--network',
		networkName,
		'-p',
		`127.0.0.1:${adminPort}:8789`,
		'-e',
		'DATABASE_DRIVER=postgres',
		'-e',
		`DATABASE_URL=postgres://${DB_USER}:${DB_PASSWORD}@${postgresName}:5432/${DB_NAME}`,
		'-e',
		`ADMIN_USERNAME=${ADMIN_USERNAME}`,
		'-e',
		`ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
		'-e',
		// 本脚本验证「应急账密回滚路径」：显式打开开关后才能走下面的登录断言。
		// 生产默认关闭（403）由 admin-password-policy.test.ts 覆盖。
		'ADMIN_PASSWORD_LOGIN=on',
		'-e',
		'ADMIN_COOKIE_SECURE=',
		'-e',
		'AUTO_MIGRATE=1',
		IMAGE,
	]);
	log(`admin ${adminName} (AUTO_MIGRATE=1)`);

	await waitFor('admin /dashboard', async () => {
		const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', adminName], {
			encoding: 'utf8',
		}).stdout.trim();
		if (state === 'exited' || state === 'dead') {
			collectLogs();
			fail(`admin container exited before ready\n--- admin logs ---\n${containerLogs.admin}`);
		}
		try {
			const response = await fetch(`${baseUrl()}/dashboard`);
			return response.status === 200;
		} catch {
			return false;
		}
	});

	// ---------------------------------------------------------------- image content
	await record('image carries normal .next, ui-dist, node-server-dist, public, next + full deps', async () => {
		const output = docker([
			'run',
			'--rm',
			'--entrypoint',
			'sh',
			IMAGE,
			'-c',
			[
				'set -e',
				'test -d /app/packages/admin/.next',
				'test ! -e /app/packages/admin/.next/standalone',
				'test -d /app/packages/admin/ui-dist/assets',
				'test -f /app/packages/admin/ui-dist/index.html',
				'test -f /app/packages/admin/ui-dist/ui-version.json',
				'test -d /app/packages/admin/node-server-dist',
				'test -f /app/packages/admin/node-server-dist/node-server.mjs',
				'test -d /app/packages/admin/public',
				'test -f /app/packages/admin/next.config.mjs',
				'test -d /app/node_modules/next',
				'test -d /app/node_modules/react',
				'echo IMAGE_CONTENT_OK',
			].join(' && '),
		]);
		assert(output.includes('IMAGE_CONTENT_OK'), output);
		return 'no .next/standalone; next/react/ui-dist/node-server-dist present';
	});

	// 4.1.3：部署不再依赖 Next basePath/standalone，公网前缀只在前端构建期生效。
	await record('built .next has no basePath/assetPrefix and no standalone output', async () => {
		const output = docker([
			'run',
			'--rm',
			'--entrypoint',
			'node',
			IMAGE,
			'--input-type=commonjs',
			'-e',
			[
				"const fs=require('fs');",
				"const m=JSON.parse(fs.readFileSync('/app/packages/admin/.next/routes-manifest.json','utf8'));",
				"const standalone=fs.existsSync('/app/packages/admin/.next/standalone');",
				"process.stdout.write(JSON.stringify({basePath:m.basePath,assetPrefix:m.assetPrefix??'',standalone}));",
			].join(''),
		]);
		const parsed = JSON.parse(output);
		assert(parsed.basePath === '', `expected empty basePath, got ${JSON.stringify(parsed.basePath)}`);
		assert(!parsed.assetPrefix, `expected empty assetPrefix, got ${JSON.stringify(parsed.assetPrefix)}`);
		assert(parsed.standalone === false, 'expected no .next/standalone output');
		return 'basePath="", assetPrefix="", no standalone';
	});

	// ---------------------------------------------------------------- UI + assets
	let dashboardHtml = '';
	let assetPath = '';
	await record('GET /dashboard -> SPA HTML', async () => {
		const response = await fetch(`${baseUrl()}/dashboard`);
		dashboardHtml = await response.text();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(headerIncludes(response, 'content-type', 'text/html'), 'expected text/html');
		assert(headerIncludes(response, 'cache-control', 'no-store'), 'expected no-store HTML');
		assert(dashboardHtml.includes('id="root"'), 'missing #root');
		const match = dashboardHtml.match(/src="([^"]*\/assets\/[^"]+\.js)"/);
		assert(match, 'missing hashed /assets/*.js entry in HTML');
		assetPath = match[1];
		return `200 text/html no-store, entry ${assetPath}`;
	});

	await record('GET / -> same SPA entry', async () => {
		const response = await fetch(`${baseUrl()}/`);
		const body = await response.text();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body.includes('id="root"'), 'missing #root');
		return '200 text/html';
	});

	await record('GET /gateway/users/u-1 -> same SPA HTML (deep link refresh)', async () => {
		const response = await fetch(`${baseUrl()}/gateway/users/u-1`);
		const body = await response.text();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body === dashboardHtml, 'detail HTML should be the same SPA entry');
		return '200 text/html, identical entry';
	});

	await record('GET hashed asset -> 200 javascript + immutable', async () => {
		const response = await fetch(`${baseUrl()}${assetPath}`);
		const body = await response.text();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(headerIncludes(response, 'content-type', 'javascript'), 'expected javascript content-type');
		assert(headerIncludes(response, 'cache-control', 'immutable'), 'expected immutable cache');
		assert(body.length > 1000, `asset too small (${body.length} bytes)`);
		return `200 ${response.headers.get('content-type')}, ${body.length} bytes`;
	});

	await record('GET /brand/openai-emblem.svg -> 200 image/svg+xml', async () => {
		const response = await fetch(`${baseUrl()}/brand/openai-emblem.svg`);
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(headerIncludes(response, 'content-type', 'image/svg+xml'), 'expected image/svg+xml');
		return '200 image/svg+xml';
	});

	await record('GET /index.html -> SPA entry without caching', async () => {
		const response = await fetch(`${baseUrl()}/index.html`);
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(headerIncludes(response, 'cache-control', 'no-store'), 'expected no-store entry');
		return '200 text/html no-store';
	});

	await record('GET /ui-version.json -> uncached JSON matching the entry build', async () => {
		const response = await fetch(`${baseUrl()}/ui-version.json`);
		const body = await response.json();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(
			headerIncludes(response, 'content-type', 'application/json'),
			'expected application/json',
		);
		assert(headerIncludes(response, 'cache-control', 'no-store'), 'expected no-store metadata');
		assert(typeof body.buildId === 'string' && body.buildId.length > 0, 'missing buildId');
		const entry = await fetch(`${baseUrl()}${assetPath}`);
		const entrySource = await entry.text();
		assert(entrySource.includes(body.buildId), 'entry bundle does not contain the metadata buildId');
		return `200 application/json no-store, buildId ${body.buildId}`;
	});

	await record('GET /.vite/manifest.json -> 404 (build internals not served)', async () => {
		const response = await fetch(`${baseUrl()}/.vite/manifest.json`);
		const body = await response.text();
		assert(response.status === 404, `expected 404, got ${response.status}`);
		assert(!body.includes('id="root"'), 'build internals must not fall back to the SPA entry');
		return '404';
	});

	await record('POST /ui-version.json -> 405 (metadata is read-only)', async () => {
		const response = await fetch(`${baseUrl()}/ui-version.json`, { method: 'POST' });
		assert(response.status === 405, `expected 405, got ${response.status}`);
		return '405';
	});

	// 1.2 阶段其余 21 个页面仍由 Next 渲染：它们的 `/_next/**` 资源必须真的可达，
	// 否则「保留 Next 页面」只剩 HTML，浏览器会白屏。
	// 2.2 起全部 21 个内容页都由 SPA 接管；Next 只保留 `/api/**`。
	await record('GET previously-Next page -> same SPA entry', async () => {
		for (const pathname of ['/gateway/models', '/gateway/config', '/gateway/tools/invocations']) {
			const response = await fetch(`${baseUrl()}${pathname}`);
			const body = await response.text();
			assert(response.status === 200, `${pathname}: expected 200, got ${response.status}`);
			assert(headerIncludes(response, 'content-type', 'text/html'), `${pathname}: expected text/html`);
			assert(body.includes('id="root"'), `${pathname}: missing SPA entry`);
		}
		return '/gateway/models, /gateway/config, /gateway/tools/invocations -> SPA HTML';
	});

	await record('GET unknown page -> Next 404, never SPA HTML', async () => {
		const response = await fetch(`${baseUrl()}/gateway/not-a-page`);
		const body = await response.text();
		assert(response.status === 404, `expected 404, got ${response.status}`);
		assert(!body.includes('id="root"'), 'unknown page must not fall back to the SPA entry');
		return '404';
	});

	await record('GET missing asset -> 404, never HTML', async () => {
		const response = await fetch(`${baseUrl()}/assets/does-not-exist.js`);
		const body = await response.text();
		assert(response.status === 404, `expected 404, got ${response.status}`);
		assert(!body.includes('id="root"'), 'missing asset must not fall back to index.html');
		return '404';
	});

	await record('POST /dashboard -> 405 (no HTML 200)', async () => {
		const response = await fetch(`${baseUrl()}/dashboard`, { method: 'POST' });
		assert(response.status === 405, `expected 405, got ${response.status}`);
		assert((response.headers.get('allow') ?? '').includes('GET'), 'missing Allow header');
		return '405 Allow: GET, HEAD';
	});

	await record('HEAD /dashboard -> 200 without body', async () => {
		const response = await fetch(`${baseUrl()}/dashboard`, { method: 'HEAD' });
		const body = await response.text();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body === '', 'HEAD must not return a body');
		return '200 empty body';
	});

	// ---------------------------------------------------------------- real Next API
	let sessionCookie = '';
	await record('POST /api/auth/login (wrong password) -> 401 JSON', async () => {
		const response = await fetch(`${baseUrl()}/api/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: ADMIN_USERNAME, password: 'wrong-password' }),
		});
		const body = await response.json();
		assert(response.status === 401, `expected 401, got ${response.status}`);
		assert(headerIncludes(response, 'content-type', 'application/json'), 'expected JSON');
		assert(body.success === false, 'expected success:false');
		return '401 success:false';
	});

	await record('POST /api/auth/login (real handler) -> 200 + Set-Cookie admin_session', async () => {
		const response = await fetch(`${baseUrl()}/api/auth/login`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD }),
		});
		const body = await response.json();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body.success === true, 'expected success:true');
		const cookies = response.headers.getSetCookie?.() ?? [];
		assert(cookies.some((cookie) => cookie.startsWith('admin_session=')), 'missing admin_session cookie');
		sessionCookie = cookies.map((cookie) => cookie.split(';')[0]).join('; ');
		return '200 success:true, admin_session Set-Cookie';
	});

	await record('GET /api/auth/check with cookie -> authenticated true (cookies() context)', async () => {
		const response = await fetch(`${baseUrl()}/api/auth/check`, {
			headers: { cookie: sessionCookie },
		});
		const body = await response.json();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body.authenticated === true, 'expected authenticated:true');
		return '200 authenticated:true';
	});

	await record('GET /api/admin/users without cookie -> 401/403 JSON', async () => {
		const response = await fetch(`${baseUrl()}/api/admin/users`);
		const contentType = response.headers.get('content-type') ?? '';
		assert([401, 403].includes(response.status), `expected 401/403, got ${response.status}`);
		assert(!contentType.includes('text/html'), 'protected API must not return HTML');
		return `${response.status} ${contentType}`;
	});

	await record('GET /api/admin/stats with cookie -> real DB-backed JSON', async () => {
		const response = await fetch(`${baseUrl()}/api/admin/stats?range=24h`, {
			headers: { cookie: sessionCookie },
		});
		const body = await response.json();
		assert(response.status === 200, `expected 200, got ${response.status}`);
		assert(body.success === true, 'expected success:true');
		assert(body.data != null, 'expected data');
		return '200 success:true with data';
	});

	await record('GET unknown /api -> 404, never SPA HTML', async () => {
		const response = await fetch(`${baseUrl()}/api/does-not-exist`);
		const body = await response.text();
		assert(response.status === 404, `expected 404, got ${response.status}`);
		assert(!body.includes('id="root"'), 'unknown API must not return SPA HTML');
		return '404';
	});

	await record('POST /api/locale -> 200 + NEXT_LOCALE; invalid -> 400', async () => {
		const ok = await fetch(`${baseUrl()}/api/locale`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: sessionCookie },
			body: JSON.stringify({ locale: 'zh' }),
		});
		const okCookies = ok.headers.getSetCookie?.() ?? [];
		assert(ok.status === 200, `valid locale expected 200, got ${ok.status}`);
		assert(okCookies.some((cookie) => cookie.startsWith('NEXT_LOCALE=')), 'missing NEXT_LOCALE cookie');
		const bad = await fetch(`${baseUrl()}/api/locale`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie: sessionCookie },
			body: JSON.stringify({ locale: 'not-a-locale' }),
		});
		assert(bad.status === 400, `invalid locale expected 400, got ${bad.status}`);
		return '200 NEXT_LOCALE / 400 invalid';
	});

	await record('POST /api/auth/logout -> session invalidated on the same cookie', async () => {
		const response = await fetch(`${baseUrl()}/api/auth/logout`, {
			method: 'POST',
			headers: { cookie: sessionCookie },
		});
		assert(response.status === 200, `expected 200, got ${response.status}`);
		const check = await fetch(`${baseUrl()}/api/auth/check`, { headers: { cookie: sessionCookie } });
		const body = await check.json();
		assert(body.authenticated === false, 'old cookie must not stay authenticated after logout');
		return '200, auth/check authenticated:false';
	});

	await record('WS upgrade without session is closed with 1008 before any realtime data', async () => {
		const wsModule = await import('ws');
		const WebSocketClient = wsModule.WebSocket ?? wsModule.default;
		await new Promise((resolve, reject) => {
			const socket = new WebSocketClient(`${baseUrl().replace('http', 'ws')}/api/admin/playground/realtime?routeId=none`);
			let received = false;
			let lastError = null;
			const timer = setTimeout(() => {
				socket.terminate();
				reject(
					new Error(
						`unauthenticated realtime socket was not closed with 1008 within 5s${
							lastError ? ` (last error: ${lastError.message})` : ''
						}`,
					),
				);
			}, 5000);
			socket.on('message', () => {
				received = true;
			});
			// 升级失败也可能只触发 error：只记录，不当作通过，仍要求 close 1008。
			socket.on('error', (error) => {
				lastError = error instanceof Error ? error : new Error(String(error));
			});
			socket.on('close', (code) => {
				clearTimeout(timer);
				if (received) reject(new Error('unauthenticated realtime socket received data'));
				else if (code === 1008) resolve();
				else reject(new Error(`expected close 1008, got ${code}`));
			});
		});
		return 'closed 1008 without data';
	});

	log('all production assertions passed');
	for (const result of results) log(`  - ${result.name}: ${result.detail}`);
}

let exitCode = 0;
try {
	await main();
} catch (error) {
	exitCode = 1;
	console.error(`[admin/verify-production] FAILED: ${error instanceof Error ? error.message : String(error)}`);
	collectLogs();
	if (containerLogs.admin) {
		console.error('--- admin container logs (tail 200) ---');
		console.error(containerLogs.admin);
	}
	if (containerLogs.postgres) {
		console.error('--- postgres container logs (tail 200) ---');
		console.error(containerLogs.postgres);
	}
} finally {
	for (const name of [adminName, postgresName]) {
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
		} catch {
			// ignore cleanup errors
		}
	}
	try {
		execFileSync('docker', ['network', 'rm', networkName], { stdio: 'ignore' });
	} catch {
		// ignore cleanup errors
	}
}

if (exitCode !== 0) process.exit(exitCode);
