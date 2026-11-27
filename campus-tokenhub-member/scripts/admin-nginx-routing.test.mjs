/**
 * 管理台 nginx 前缀剥离（4.2）。
 *
 * 约束（design D1 / spec「admin requests are stripped exactly once」）：
 * - 只有 `/tokenhub/admin/**` 被剥掉一次前缀，下游（Node 8789）收到根路径；
 * - query、请求体、Upgrade 头都不丢；
 * - `/tokenhub/admin` 与 `/tokenhub/admin/` 都不产生重定向循环；
 * - 同名非边界路径（`/tokenhub/administrator` 等）仍归推理网关；
 * - 门户（保留前缀）与推理网关（剥 `/tokenhub`）的 location 行为不变。
 *
 * 做法：用渲染后的真实配置启动隔离 nginx，配一个按端口分流的 **真读请求体** 的
 * Node 上游，直接断言“哪个上游收到了什么 URI / 方法 / 头 / body”，而不是解析配置
 * 文本，也不用 `$content_length` 这类只反映请求头的近似值。
 *
 * 依赖 Docker（本机需有 `nginx:1.27-alpine` 与 `node:22-alpine3.22`，可用
 * `NGINX_TEST_IMAGE` / `NGINX_TEST_UPSTREAM_IMAGE` 覆盖）；不触碰现有容器/网络/端口。
 * 运行：`npm run test:admin-nginx`（等价 `node --test scripts/admin-nginx-routing.test.mjs`）。
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'deploy', 'nginx.conf.template');
const NGINX_IMAGE = process.env.NGINX_TEST_IMAGE?.trim() || 'nginx:1.27-alpine';
const UPSTREAM_IMAGE = process.env.NGINX_TEST_UPSTREAM_IMAGE?.trim() || 'node:22-alpine3.22';

const suffix = `${Date.now()}-${process.pid}`;
const networkName = `octafuse-nginx-test-${suffix}`;
const echoName = `octafuse-nginx-echo-${suffix}`;
const gatewayName = `octafuse-nginx-gw-${suffix}`;

let workDir = '';
let gatewayPort = 0;

function docker(args) {
	const result = spawnSync('docker', args, { encoding: 'utf8' });
	if (result.status !== 0) {
		const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : '';
		throw new Error(`docker ${args.join(' ')} failed (exit ${result.status})${stderr ? `: ${stderr}` : ''}`);
	}
	return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = createServer();
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

/**
 * 上游 echo：按端口区分 portal(3000) / proxy(8787) / admin(8789)，
 * 回显 nginx 真实转过来的 URI、方法、Upgrade 头和 **读完的请求体**。
 */
function echoServerSource() {
	return `import { createServer } from 'node:http';

const ports = (process.env.ECHO_PORTS || '3000,8787,8789').split(',');

for (const port of ports) {
	createServer((req, res) => {
		let body = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => {
			body += chunk;
		});
		req.on('end', () => {
			res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
			res.end(
				'upstream=' + port +
					'|uri=' + req.url +
					'|upgrade=' + (req.headers.upgrade || '') +
					'|method=' + req.method +
					'|body=' + body
			);
		});
	}).listen(Number(port), '0.0.0.0');
}
`;
}

function renderGatewayConfig() {
	const template = readFileSync(TEMPLATE, 'utf8');
	assert.ok(template.includes('${NGINX_PUBLIC_PROTO}'), 'template must use the NGINX_PUBLIC_PROTO placeholder');
	// envsubst 在容器里会把模板里所有占位符都替掉；这里必须一并渲染 NGINX_RESOLVER，
	// 否则 `resolver ${NGINX_RESOLVER}` 会以字面量进 nginx，nginx -t 直接报 host not found。
	return template
		.replaceAll('${NGINX_PUBLIC_PROTO}', 'https')
		.replaceAll('${NGINX_RESOLVER}', '127.0.0.11');
}

async function waitFor(label, check, timeoutMs = 30_000) {
	const startedAt = Date.now();
	let lastError = '';
	while (Date.now() - startedAt < timeoutMs) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(250);
	}
	throw new Error(`${label} timed out${lastError ? ` (last error: ${lastError})` : ''}`);
}

async function probe(pathname, init) {
	const response = await fetch(`http://127.0.0.1:${gatewayPort}${pathname}`, init);
	const body = await response.text();
	return {
		status: response.status,
		location: response.headers.get('location'),
		setCookie: response.headers.get('set-cookie'),
		body,
	};
}

/** undici 的 fetch 拒绝 `Upgrade` 头，升级相关断言走原始 http 客户端。 */
function rawProbe(pathname, headers) {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{ host: '127.0.0.1', port: gatewayPort, path: pathname, method: 'GET', headers },
			(response) => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', (chunk) => {
					body += chunk;
				});
				response.on('end', () =>
					resolve({ status: response.statusCode, location: response.headers.location ?? null, body }),
				);
			},
		);
		request.on('error', reject);
		request.end();
	});
}

/** 上游 echo 的完整预期响应。 */
function expectEcho(port, uri, extra = {}) {
	const { upgrade = '', method = 'GET', body = '' } = extra;
	return `upstream=${port}|uri=${uri}|upgrade=${upgrade}|method=${method}|body=${body}`;
}

function assertUpstream(probeResult, expected) {
	assert.equal(probeResult.status, 200, `expected 200, got ${probeResult.status}: ${probeResult.body}`);
	assert.equal(probeResult.location, null, `unexpected redirect to ${probeResult.location}`);
	assert.equal(probeResult.body, expected, `expected upstream echo "${expected}", got "${probeResult.body}"`);
}

describe('admin nginx prefix strip', () => {
	before(async () => {
		// 必须放在 Docker Desktop 已共享的路径（仓库在 /Users 下）；/var/folders 的
		// TMPDIR 不在默认共享范围内，单文件 bind mount 会报 "not a directory"。
		workDir = join(ROOT, 'node_modules', '.cache', 'octafuse-nginx', suffix);
		mkdirSync(workDir, { recursive: true });
		writeFileSync(join(workDir, 'echo.mjs'), echoServerSource());
		writeFileSync(join(workDir, 'default.conf'), renderGatewayConfig());

		gatewayPort = await getFreePort();
		docker(['network', 'create', networkName]);
		docker([
			'run',
			'-d',
			'--name',
			echoName,
			'--network',
			networkName,
			'--network-alias',
			'portal',
			'--network-alias',
			'gateway-proxy',
			'--network-alias',
			'gateway-admin',
			'-v',
			`${join(workDir, 'echo.mjs')}:/echo.mjs:ro`,
			UPSTREAM_IMAGE,
			'node',
			'/echo.mjs',
		]);

		// 先做语法检查：渲染后的配置必须能被 nginx 接受。
		execFileSync(
			'docker',
			[
				'run',
				'--rm',
				'--network',
				networkName,
				'-v',
				`${join(workDir, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
				NGINX_IMAGE,
				'nginx',
				'-t',
			],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
		);

		docker([
			'run',
			'-d',
			'--name',
			gatewayName,
			'--network',
			networkName,
			'-p',
			`127.0.0.1:${gatewayPort}:80`,
			'-v',
			`${join(workDir, 'default.conf')}:/etc/nginx/conf.d/default.conf:ro`,
			NGINX_IMAGE,
		]);

		await waitFor('gateway nginx', async () => (await probe('/nginx-health')).status === 200);
		// 上游是独立容器，起得比 nginx 慢；先确认三个端口都已监听，避免首个用例假失败。
		await waitFor('upstream echo', () => {
			for (const port of [3000, 8787, 8789]) {
				docker([
					'exec',
					echoName,
					'node',
					'-e',
					`fetch('http://127.0.0.1:${port}/warmup').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`,
				]);
			}
			return true;
		});
	});

	after(() => {
		for (const name of [gatewayName, echoName]) {
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
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it('serves the admin root at "/" without a redirect', async () => {
		assertUpstream(await probe('/tokenhub/admin'), expectEcho(8789, '/'));
	});

	it('keeps the query string on the exact admin location', async () => {
		assertUpstream(await probe('/tokenhub/admin?from=mail&x=1'), expectEcho(8789, '/?from=mail&x=1'));
	});

	it('strips the prefix from admin pages, assets and API paths', async () => {
		assertUpstream(await probe('/tokenhub/admin/dashboard'), expectEcho(8789, '/dashboard'));
		assertUpstream(await probe('/tokenhub/admin/dashboard?tab=users'), expectEcho(8789, '/dashboard?tab=users'));
		assertUpstream(await probe('/tokenhub/admin/gateway/users/u-1'), expectEcho(8789, '/gateway/users/u-1'));
		assertUpstream(await probe('/tokenhub/admin/assets/index-abc.js'), expectEcho(8789, '/assets/index-abc.js'));
		assertUpstream(await probe('/tokenhub/admin/api/admin/models?limit=5'), expectEcho(8789, '/api/admin/models?limit=5'));
		assertUpstream(
			await probe('/tokenhub/admin/api/admin/playground/realtime?routeId=x'),
			expectEcho(8789, '/api/admin/playground/realtime?routeId=x'),
		);
	});

	it('does not loop when the request carries a trailing slash', async () => {
		assertUpstream(await probe('/tokenhub/admin/'), expectEcho(8789, '/'));
		assertUpstream(await probe('/tokenhub/admin/?tab=users'), expectEcho(8789, '/?tab=users'));
	});

	it('forwards the real request body and Upgrade header with the stripped path', async () => {
		const payload = JSON.stringify({ username: 'admin', password: 'x' });
		const posted = await probe('/tokenhub/admin/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: payload,
		});
		assertUpstream(
			posted,
			expectEcho(8789, '/api/auth/login', { method: 'POST', body: payload }),
		);

		const upgraded = await rawProbe('/tokenhub/admin/api/admin/playground/realtime', {
			Upgrade: 'websocket',
			Connection: 'Upgrade',
		});
		assertUpstream(upgraded, expectEcho(8789, '/api/admin/playground/realtime', { upgrade: 'websocket' }));
	});

	it('keeps same-name non-boundary paths on the inference gateway', async () => {
		assertUpstream(await probe('/tokenhub/administrator'), expectEcho(8787, '/administrator'));
		assertUpstream(await probe('/tokenhub/adminfoo'), expectEcho(8787, '/adminfoo'));
	});

	it('seeds the Chinese default locale cookie only when the browser has none', async () => {
		const seeded = await probe('/tokenhub/admin/dashboard');
		assert.match(seeded.setCookie ?? '', /NEXT_LOCALE=zh/, 'first visit should seed NEXT_LOCALE=zh');
		assert.match(seeded.setCookie ?? '', /Path=\//, 'cookie must be readable by the admin SPA');

		const kept = await probe('/tokenhub/admin/dashboard', {
			headers: { cookie: 'NEXT_LOCALE=en' },
		});
		assert.equal(kept.setCookie, null, 'must not override an existing locale cookie');

		const exact = await probe('/tokenhub/admin');
		assert.match(exact.setCookie ?? '', /NEXT_LOCALE=zh/, 'exact admin entry should seed too');

		const portal = await probe('/tokenhub/portal/dashboard');
		assert.equal(portal.setCookie, null, 'portal responses must not carry the admin locale cookie');
	});

	it('leaves the portal prefix and the gateway strip unchanged', async () => {
		assertUpstream(await probe('/tokenhub/portal/dashboard'), expectEcho(3000, '/tokenhub/portal/dashboard'));
		assertUpstream(await probe('/tokenhub/health'), expectEcho(8787, '/health'));
		assertUpstream(await probe('/tokenhub/v1/models?x=1'), expectEcho(8787, '/v1/models?x=1'));
	});

	it('keeps unknown public paths closed and the health endpoint local', async () => {
		const unknown = await probe('/');
		assert.equal(unknown.status, 404, `expected 404 for "/", got ${unknown.status}`);
		assert.equal((await probe('/nginx-health')).body, 'ok');
	});
});
