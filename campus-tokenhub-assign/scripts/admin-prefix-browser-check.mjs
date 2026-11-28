/**
 * 管理台公网前缀的端到端验收（4.3.1）。
 *
 * 在隔离栈里跑真实链路：新版镜像（`ADMIN_UI_PUBLIC_PATH=/tokenhub/admin`）
 * + 渲染后的 `deploy/nginx.conf.template` + 临时 Postgres，全部用随机名称/端口，
 * 不触碰现有容器。然后用 Playwright 走全部 20 个菜单页 + 动态详情 + 旧地址 +
 * 语言切换 + 跨标签会话切换，并断言：
 *   - 页面内的资源/API 请求都带前缀，普通切页不产生新 document；
 *   - 未登录的实时通道经 nginx 仍以 1008 关闭；
 *   - 另一个标签页在身份切换窗口立即卸载敏感 UI，settle 后重新一致。
 *
 * 用法：
 *   node scripts/admin-prefix-browser-check.mjs
 *   ADMIN_CHECK_SKIP_BUILD=1 ADMIN_CHECK_IMAGE=octafuse-admin:verify-4.3 ...
 *   ADMIN_CHECK_ONLY=browser ADMIN_CHECK_BASE=http://127.0.0.1:PORT   # 复用已启动的栈
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(ROOT, 'deploy', 'nginx.conf.template');
const IMAGE = process.env.ADMIN_CHECK_IMAGE?.trim() || 'octafuse-admin:verify-prefix';
const SKIP_BUILD = process.env.ADMIN_CHECK_SKIP_BUILD === '1';
const NGINX_IMAGE = process.env.ADMIN_CHECK_NGINX_IMAGE?.trim() || 'nginx:1.27-alpine';
const POSTGRES_IMAGE = process.env.ADMIN_CHECK_POSTGRES_IMAGE?.trim() || 'postgres:16-alpine';
const PREFIX = '/tokenhub/admin';
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = `check-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
const DB_PASSWORD = `check-${Math.random().toString(36).slice(2)}`;

const suffix = `${Date.now()}-${process.pid}`;
const networkName = `octafuse-prefix-check-${suffix}`;
const postgresName = `octafuse-prefix-pg-${suffix}`;
const adminName = `octafuse-prefix-admin-${suffix}`;
const echoName = `octafuse-prefix-echo-${suffix}`;
const nginxName = `octafuse-prefix-nginx-${suffix}`;
const workDir = join(ROOT, 'node_modules', '.cache', 'octafuse-prefix-check', suffix);

/** 4.3.1 要求逐项记录的验收结果。 */
const results = [];
const consoleErrors = [];
const unprefixedRequests = [];
let base = process.env.ADMIN_CHECK_BASE?.trim() || '';
let stackStarted = false;
let browser = null;

function log(message) {
	console.log(`[admin-prefix-check] ${message}`);
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

async function waitFor(label, check, timeoutMs = 120_000) {
	const startedAt = Date.now();
	let lastError = '';
	while (Date.now() - startedAt < timeoutMs) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		await sleep(500);
	}
	fail(`${label} timed out${lastError ? ` (last error: ${lastError})` : ''}`);
}

async function step(name, run) {
	const detail = await run();
	results.push({ name, detail });
	log(`PASS ${name}${detail ? ` — ${detail}` : ''}`);
}

function renderNginxConfig() {
	const template = readFileSync(TEMPLATE, 'utf8');
	return template.replaceAll('${NGINX_PUBLIC_PROTO}', 'https');
}

function echoConfig() {
	const server = (port) => `
    server {
        listen ${port};
        location / {
            return 200 "upstream=${port}|uri=$request_uri";
        }
    }`;
	return `worker_processes 1;
error_log /dev/stderr warn;
events { worker_connections 64; }
http {
    access_log off;${server(3000)}${server(8787)}
}
`;
}

async function startStack() {
	if (base) {
		log(`reusing ${base}`);
		return;
	}
	if (!SKIP_BUILD) {
		log(`building ${IMAGE} with ADMIN_UI_PUBLIC_PATH=${PREFIX}`);
		docker(
			[
				'build',
				'--progress=plain',
				'-f',
				'Dockerfile.admin',
				'--build-arg',
				`ADMIN_UI_PUBLIC_PATH=${PREFIX}`,
				'-t',
				IMAGE,
				'.',
			],
			{ cwd: join(ROOT, 'local-stack', 'octafuse-gateway'), inherit: true },
		);
	}
	docker(['image', 'inspect', IMAGE]);

	mkdirSync(workDir, { recursive: true });
	writeFileSync(join(workDir, 'nginx.conf'), renderNginxConfig());
	writeFileSync(join(workDir, 'echo.conf'), echoConfig());

	const nginxPort = await getFreePort();
	base = `http://127.0.0.1:${nginxPort}`;

	docker(['network', 'create', networkName]);
	// 网络一建好就算“本脚本拉起的栈”：后续任一 `docker run` 失败也要在 finally 里删网络。
	stackStarted = true;
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
		'POSTGRES_USER=octafuse',
		'-e',
		`POSTGRES_PASSWORD=${DB_PASSWORD}`,
		'-e',
		'POSTGRES_DB=octafuse',
		POSTGRES_IMAGE,
	]);
	await waitFor(
		'postgres',
		() => spawnSync('docker', ['exec', postgresName, 'pg_isready', '-U', 'octafuse'], { encoding: 'utf8' }).status === 0,
		60_000,
	);

	docker([
		'run',
		'-d',
		'--name',
		adminName,
		'--network',
		networkName,
		'--network-alias',
		'gateway-admin',
		'-e',
		'DATABASE_DRIVER=postgres',
		'-e',
		`DATABASE_URL=postgres://octafuse:${DB_PASSWORD}@${postgresName}:5432/octafuse`,
		'-e',
		`ADMIN_USERNAME=${ADMIN_USERNAME}`,
		'-e',
		`ADMIN_PASSWORD=${ADMIN_PASSWORD}`,
		'-e',
		// 这个检查用账密表单走 UI 全流程，属于「应急回滚路径」：显式打开开关。
		// 正常部署默认关闭账密登录，人类登录走门户 SSO。
		'ADMIN_PASSWORD_LOGIN=on',
		'-e',
		'ADMIN_COOKIE_SECURE=',
		// 镜像按 PREFIX 构建，入口脚本会用这个运行期值做前缀自检；
		// 不一致会直接 exit 1，正好也覆盖“前缀不匹配就拒绝启动”的反向行为。
		'-e',
		`ADMIN_UI_PUBLIC_PATH=${PREFIX}`,
		'-e',
		'AUTO_MIGRATE=1',
		IMAGE,
	]);

	// 门户/网关只作为 nginx upstream 占位（浏览器验收只走管理台）。
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
		'-v',
		`${join(workDir, 'echo.conf')}:/etc/nginx/nginx.conf:ro`,
		NGINX_IMAGE,
	]);

	// nginx 在启动时就解析 upstream 名称：必须等两个带别名的容器先进入 running，
	// 否则会偶发 `host not found in upstream`。
	for (const name of [adminName, echoName]) {
		await waitFor(
			`${name} running`,
			() =>
				spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', name], {
					encoding: 'utf8',
				}).stdout.trim() === 'running',
			60_000,
		);
	}

	docker([
		'run',
		'-d',
		'--name',
		nginxName,
		'--network',
		networkName,
		'-p',
		`127.0.0.1:${nginxPort}:80`,
		'-e',
		'NGINX_PUBLIC_PROTO=https',
		'-v',
		`${join(workDir, 'nginx.conf')}:/etc/nginx/conf.d/default.conf:ro`,
		NGINX_IMAGE,
	]);
	log(`stack ready at ${base} (prefix ${PREFIX})`);

	// Docker Desktop 的端口转发偶尔慢一拍：先确认容器在跑，避免把启动失败
	// 误报成“登录页超时”。
	await sleep(1000);
	for (const name of [nginxName, adminName, echoName]) {
		const state = spawnSync('docker', ['inspect', '-f', '{{.State.Status}}', name], {
			encoding: 'utf8',
		}).stdout.trim();
		if (state !== 'running') {
			const logs = spawnSync('docker', ['logs', '--tail', '60', name], { encoding: 'utf8' });
			fail(`${name} is ${state || 'missing'}\n${logs.stdout}\n${logs.stderr}`);
		}
	}

	await waitFor('admin login page', async () => {
		const response = await fetch(`${base}${PREFIX}/dashboard`);
		return response.status === 200;
	});
}

async function stopStack() {
	for (const name of [nginxName, echoName, adminName, postgresName]) {
		try {
			execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
		} catch {
			// ignore cleanup errors
		}
	}
	if (stackStarted) {
		try {
			execFileSync('docker', ['network', 'rm', networkName], { stdio: 'ignore' });
		} catch {
			// ignore cleanup errors
		}
	}
	try {
		rmSync(workDir, { recursive: true, force: true });
	} catch {
		// ignore cleanup errors
	}
}

function loadPlaywright() {
	const require = createRequire(import.meta.url);
	try {
		return require('playwright');
	} catch {
		return require(join(process.env.HOME ?? '', 'node_modules', 'playwright'));
	}
}

/** 记录同源但没带前缀的请求（前缀部署的核心回归点）。 */
function trackRequests(page) {
	page.on('request', (request) => {
		const url = new URL(request.url());
		if (`${url.protocol}//${url.host}` !== base) return;
		const { pathname } = url;
		if (pathname.startsWith(PREFIX)) return;
		if (
			pathname === '/favicon.ico' ||
			pathname.startsWith('/_next/') ||
			pathname.startsWith('/assets/') ||
			pathname.startsWith('/brand/') ||
			pathname.startsWith('/api/') ||
			pathname === '/ui-version.json'
		) {
			unprefixedRequests.push(`${request.method()} ${pathname}`);
		}
	});
	page.on('console', (message) => {
		if (message.type() === 'error') consoleErrors.push(message.text());
	});
}

function pageUrl(path) {
	return `${base}${PREFIX}${path}`;
}

async function login(page) {
	await page.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
	await page.locator('input#username').fill(ADMIN_USERNAME);
	await page.locator('input#password').fill(ADMIN_PASSWORD);
	await page.locator('button[type="submit"]').click();
	await page.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
	await page.waitForFunction(() => window.location.pathname.startsWith('/tokenhub/admin/'));
	await page.evaluate(() => {
		window.__adminDocMark = 'initial';
	});
}

const PAGE_ROUTES = [
	'/dashboard',
	'/gateway/providers',
	'/gateway/models',
	'/gateway/routes',
	'/gateway/playground',
	'/gateway/simulator',
	'/gateway/users',
	'/gateway/keys',
	'/gateway/request-logs',
	'/gateway/audit-logs',
	'/gateway/tools',
	'/gateway/mcp',
	'/gateway/tools/invocations',
	'/gateway/analytics/models',
	'/gateway/analytics/providers',
	'/gateway/analytics/users',
	'/gateway/analytics/reliability',
	'/gateway/admin-api-keys',
	'/gateway/config',
	'/gateway/maintenance',
];

async function runBrowserChecks() {
	const { chromium } = loadPlaywright();
	browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
	const page = await context.newPage();
	trackRequests(page);

	await step('deep link to /tokenhub/admin/dashboard shows the login form', async () => {
		await page.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await page.locator('input#username').waitFor({ timeout: 30_000 });
		const entry = await page.evaluate(() =>
			[...document.querySelectorAll('script[src]')].map((node) => node.getAttribute('src')),
		);
		const assets = entry.filter(Boolean);
		if (!assets.length || !assets.every((src) => src.startsWith(`${PREFIX}/assets/`))) {
			fail(`entry bundle is not served under the prefix: ${JSON.stringify(assets)}`);
		}
		return `entry ${assets[0]}`;
	});

	await step('login succeeds at the prefixed path without leaving the prefix', async () => {
		await login(page);
		return page.url().replace(base, '');
	});

	let firstLoadAssets = 0;
	page.on('response', (response) => {
		if (response.url().includes(`${PREFIX}/assets/`)) firstLoadAssets += 1;
	});

	await step('all 20 menu pages navigate client-side with prefixed assets only', async () => {
		const details = [];
		for (const route of PAGE_ROUTES) {
			const href = `${PREFIX}${route}`;
			const link = page.locator(`a[href="${href}"]`).first();
			const clickable = (await link.count()) > 0;
			if (clickable) {
				await link.click();
			} else {
				await page.goto(pageUrl(route), { waitUntil: 'domcontentloaded' });
			}
			await page.waitForURL((url) => url.pathname === href, { timeout: 30_000 });
			await page.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
			const text = (await page.locator('main').first().innerText()).trim();
			if (!text) fail(`${route}: main is empty`);
			if (/failed to (load|render)|something went wrong/i.test(text)) {
				fail(`${route}: error state rendered: ${text.slice(0, 120)}`);
			}
			const mark = clickable ? await page.evaluate(() => window.__adminDocMark) : null;
			if (clickable && mark !== 'initial') fail(`${route}: full document reload detected`);
			details.push(`${route}${clickable ? '' : ' (deep link)'}`);
		}
		return `${details.length} routes: ${details.join(', ')}`;
	});

	await step('dynamic user detail renders on a deep link', async () => {
		await page.goto(pageUrl('/gateway/users/u-1'), { waitUntil: 'domcontentloaded' });
		await page.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		await page.waitForURL((url) => url.pathname === `${PREFIX}/gateway/users/u-1`);
		const text = (await page.locator('main').first().innerText()).trim();
		if (!text) fail('user detail main is empty');
		return '/gateway/users/u-1 rendered';
	});

	await step('root path redirects to dashboard inside the SPA', async () => {
		await page.goto(`${base}${PREFIX}`, { waitUntil: 'domcontentloaded' });
		await page.waitForURL((url) => url.pathname === `${PREFIX}/dashboard`, { timeout: 30_000 });
		return `${PREFIX} -> ${PREFIX}/dashboard`;
	});

	await step('legacy OAuth bookmark redirects to the MCP tab', async () => {
		await page.goto(pageUrl('/gateway/oauth-access-tokens'), { waitUntil: 'domcontentloaded' });
		await page.waitForURL(
			(url) => url.pathname === `${PREFIX}/gateway/mcp` && url.hash === '#oauth-access-tokens',
			{ timeout: 30_000 },
		);
		return '/gateway/oauth-access-tokens -> /gateway/mcp#oauth-access-tokens';
	});

	await step('hovering a menu item prefetches its chunk under the prefix', async () => {
		let prefetched = 0;
		page.on('request', (request) => {
			if (request.url().includes(`${PREFIX}/assets/`)) prefetched += 1;
		});
		await page.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await page.locator('main').first().waitFor({ state: 'visible' });
		const before = prefetched;
		await page.locator(`a[href="${PREFIX}/gateway/models"]`).first().hover();
		await sleep(800);
		const after = prefetched;
		if (after <= before) fail('hover did not request a prefixed chunk');
		return `${after - before} chunk request(s) on hover`;
	});

	await step('locale switch persists and renders the new language', async () => {
		const response = await page.evaluate(async (prefix) => {
			const result = await fetch(`${prefix}/api/locale`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ locale: 'zh' }),
			});
			return result.status;
		}, PREFIX);
		if (response !== 200) fail(`POST ${PREFIX}/api/locale returned ${response}`);
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		const navText = await page.locator('a[href$="/dashboard"]').first().innerText();
		if (!/[\u4e00-\u9fa5]/.test(navText)) fail(`locale did not switch: ${navText}`);
		return `sidebar text: ${navText.trim()}`;
	});

	await step('another tab drops sensitive UI while this tab is still logging out', async () => {
		const other = await context.newPage();
		trackRequests(other);
		await other.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await other.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });

		let release;
		const delayed = new Promise((resolve) => {
			release = resolve;
		});
		// 先真正发出请求（服务端已销毁会话），再延迟把响应交给浏览器：
		// 复现“Cookie 已变但本页仍 pending”的窗口。页面级 route，避免影响其他标签页。
		await page.route('**/api/auth/logout', async (route) => {
			try {
				const response = await route.fetch();
				await delayed;
				await route.fulfill({ response });
			} catch {
				// pending 期间路由可能已被页面状态变化取消：以服务端 Cookie 结果为准。
			}
		});

		await page.getByRole('button', { name: /Logout|退出/ }).first().click();
		await other.locator('input#username').waitFor({ timeout: 15_000 });
		if ((await other.locator('main').count()) !== 0) {
			fail('other tab still renders the authenticated shell');
		}

		// pending 窗口内新开页：服务端会话已失效，必须直接落到登录页。
		const duringPending = await context.newPage();
		trackRequests(duringPending);
		await duringPending.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await duringPending.locator('input#username').waitFor({ timeout: 30_000 });
		await duringPending.close();

		release();
		await page.unroute('**/api/auth/logout');
		await other.locator('button[type="submit"]').waitFor({ timeout: 15_000 });
		await other.close();
		return 'sensitive UI unmounted before settle; pending new page starts signed out';
	});

	await step('login settles in a tab that was waiting on the switch', async () => {
		const waiting = await context.newPage();
		trackRequests(waiting);
		await waiting.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await waiting.locator('input#username').waitFor({ timeout: 30_000 });

		let release;
		const delayed = new Promise((resolve) => {
			release = resolve;
		});
		await page.route('**/api/auth/login', async (route) => {
			try {
				const response = await route.fetch();
				await delayed;
				await route.fulfill({ response });
			} catch {
				// 取消/已处理时忽略：断言只看两个标签页最终是否一致。
			}
		});

		await page.locator('input#username').fill(ADMIN_USERNAME);
		await page.locator('input#password').fill(ADMIN_PASSWORD);
		await page.locator('button[type="submit"]').click();
		// pending 期间另一标签页被切成 busy 登录表单（不是旧身份 UI）。
		await waiting.locator('button[type="submit"]').waitFor({ timeout: 15_000 });

		release();
		await page.unroute('**/api/auth/login');
		await waiting.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		await waiting.close();
		return 'waiting tab became authenticated after settle';
	});

	await step('closing the other tab does not break the revalidated session', async () => {
		const page2 = await context.newPage();
		trackRequests(page2);
		await page2.goto(pageUrl('/gateway/models'), { waitUntil: 'domcontentloaded' });
		await page2.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		await page2.close();
		await page.reload({ waitUntil: 'domcontentloaded' });
		await page.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		return 'reload after tab close stays authenticated';
	});

	await step('version metadata is served under the prefix and matches the entry', async () => {
		const metadata = await page.evaluate(async (prefix) => {
			const response = await fetch(`${prefix}/ui-version.json`, { cache: 'no-store' });
			const json = await response.json();
			const entry = await fetch([...document.querySelectorAll('script[src]')][0].src).then((r) => r.text());
			return { buildId: json.buildId, hasBuildId: entry.includes(json.buildId) };
		}, PREFIX);
		if (!metadata.buildId) fail('missing buildId');
		if (!metadata.hasBuildId) fail('entry bundle does not contain the buildId');
		return `buildId ${metadata.buildId}`;
	});

	await step('unauthenticated realtime upgrade through nginx closes with 1008', async () => {
		// `ws` 只装在网关 workspace 里，管理员仓库根没有该依赖。
		const gatewayRequire = createRequire(join(ROOT, 'local-stack', 'octafuse-gateway', 'package.json'));
		const wsModule = gatewayRequire('ws');
		const WebSocketClient = wsModule.WebSocket ?? wsModule.default;
		await new Promise((resolve, reject) => {
			const socket = new WebSocketClient(
				`${base.replace('http', 'ws')}${PREFIX}/api/admin/playground/realtime?routeId=none`,
			);
			let received = false;
			const timer = setTimeout(() => {
				socket.terminate();
				reject(new Error('unauthenticated realtime socket was not closed within 8s'));
			}, 8000);
			socket.on('message', () => {
				received = true;
			});
			socket.on('close', (code) => {
				clearTimeout(timer);
				if (received) reject(new Error('unauthenticated socket received data'));
				else if (code === 1008) resolve();
				else reject(new Error(`expected close 1008, got ${code}`));
			});
			socket.on('error', () => {
				// 只记录：必须以 close 1008 收尾才算通过。
			});
		});
		return 'closed 1008 without data';
	});

	await step('first-load bundle and request counts', async () => {
		const bundle = await page.evaluate(async () => {
			const nodes = [...document.querySelectorAll('script[src],link[rel="stylesheet"][href],link[rel="modulepreload"][href]')];
			const urls = [...new Set(nodes.map((node) => node.src || node.href))];
			let bytes = 0;
			for (const url of urls) {
				bytes += (await (await fetch(url)).arrayBuffer()).byteLength;
			}
			return { count: urls.length, bytes };
		});
		return `${bundle.count} initial js/css request(s), ${Math.round(bundle.bytes / 1024)} KiB`;
	});

	await step('a deploy under an open tab offers a bounded refresh and "Not now" keeps the tab usable', async () => {
		if (!stackStarted) {
			// 复用外部栈时没有容器名可改产物；该分支由 DOM 用例覆盖。
			return 'skipped (external stack)';
		}
		// 1) 用全新 context（空 HTTP 缓存，带同一份 Cookie）加载旧入口：
		//    已加载过的标签页会直接从浏览器缓存拿到旧 chunk，看不到 404。
		const flipContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
		await flipContext.addCookies(await context.cookies());
		const flipPage = await flipContext.newPage();
		trackRequests(flipPage);
		await flipPage.goto(pageUrl('/dashboard'), { waitUntil: 'domcontentloaded' });
		await flipPage.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });

		// 2) 在容器里模拟一次真实发布：所有 lazy page chunk 改名（旧标签仍引用旧名），
		//    同步重写产物内的引用并换掉版本元数据。
		const rewrite = docker([
			'exec',
			adminName,
			'node',
			'--input-type=commonjs',
			'-e',
			[
				"const fs=require('fs');",
				"const dir='/app/packages/admin/ui-dist';",
				"const assets=dir+'/assets';",
				"const pages=fs.readdirSync(assets).filter((f)=>/^page-.*\\.js$/.test(f));",
				'const map={};',
				'pages.forEach((f, i) => {',
				'  const to=`page-flip-${i}.js`;',
				'  map[f]=to;',
				'  fs.renameSync(`${assets}/${f}`, `${assets}/${to}`);',
				'});',
				"let rewritten=0;",
				'for (const f of fs.readdirSync(assets).filter((name) => name.endsWith(".js"))) {',
				'  const p=`${assets}/${f}`;',
				"  let s=fs.readFileSync(p,'utf8');",
				'  let hit=false;',
				'  for (const [from, to] of Object.entries(map)) {',
				'    if (s.includes(from)) { s=s.split(from).join(to); hit=true; }',
				'  }',
				'  if (hit) { fs.writeFileSync(p, s); rewritten+=1; }',
				'}',
				`fs.writeFileSync(dir+'/ui-version.json', JSON.stringify({buildId:'flip-${suffix}'}));`,
				"process.stdout.write(`pages=${pages.length};rewritten=${rewritten}`);",
			].join('\n'),
		]);
		if (!/pages=[1-9]/.test(rewrite) || !/rewritten=[1-9]/.test(rewrite)) {
			fail(`artifact rewrite failed: ${rewrite}`);
		}

		// 4) 旧标签软导航到该页：旧 chunk 404 → 版本核对发现新版本 → 只给一次明确提示。
		await flipPage.locator(`a[href="${PREFIX}/gateway/maintenance"]`).first().click();
		const panel = flipPage.locator('[data-admin-route-load-error="maintenance"]');
		await panel.waitFor({ timeout: 30_000 });
		await flipPage.getByText('A new admin UI version is available').waitFor({ timeout: 15_000 });
		await flipPage.getByRole('button', { name: 'Refresh page' }).waitFor({ timeout: 15_000 });

		// 5) 拒绝刷新：不重载、不循环，已加载页面仍可导航。
		await flipPage.getByRole('button', { name: 'Not now' }).click();
		await flipPage.getByText(/Refresh cancelled/i).waitFor({ timeout: 15_000 });
		await flipPage.evaluate(() => {
			window.__flipMark = 'still-here';
		});
		await flipPage.locator(`a[href="${PREFIX}/gateway/models"]`).first().click();
		await flipPage.waitForURL((url) => url.pathname === `${PREFIX}/gateway/models`, { timeout: 30_000 });
		if ((await flipPage.evaluate(() => window.__flipMark)) !== 'still-here') {
			fail('declining the refresh still reloaded the document');
		}

		// 6) 接受刷新：只有用户点击才整页重载，重载后新入口引用的 chunk 存在、页面可用。
		await flipPage.locator(`a[href="${PREFIX}/gateway/maintenance"]`).first().click();
		await flipPage.locator('[data-admin-route-load-error="maintenance"]').waitFor({ timeout: 30_000 });
		await flipPage.getByRole('button', { name: 'Refresh page' }).click();
		await flipPage.locator('main').first().waitFor({ state: 'visible', timeout: 30_000 });
		if ((await flipPage.evaluate(() => window.__flipMark)) === 'still-here') {
			fail('refresh did not reload the document');
		}
		await flipPage.waitForURL((url) => url.pathname === `${PREFIX}/gateway/maintenance`, { timeout: 30_000 });
		const text = (await flipPage.locator('main').first().innerText()).trim();
		if (!text) fail('maintenance page is empty after refresh');
		await flipPage.close();
		await flipContext.close();
		return `renamed lazy chunks (${rewrite}); refresh prompt + cancel + reload verified`;
	});

	await step('no same-origin asset/api request escaped the prefix', async () => {
		if (unprefixedRequests.length) {
			fail(`unprefixed requests: ${[...new Set(unprefixedRequests)].join(', ')}`);
		}
		return 'all same-origin asset/API requests carried /tokenhub/admin';
	});

	if (consoleErrors.length) {
		results.push({ name: 'browser console errors', detail: `${consoleErrors.length} message(s)` });
		log(`console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
	}
	results.push({ name: 'asset responses after login (incl. prefetch)', detail: `${firstLoadAssets}` });
}

let exitCode = 0;
try {
	await startStack();
	await runBrowserChecks();
	log('all browser checks passed');
	for (const result of results) log(`  - ${result.name}: ${result.detail}`);
} catch (error) {
	exitCode = 1;
	console.error(`[admin-prefix-check] FAILED: ${error instanceof Error ? error.message : String(error)}`);
	if (unprefixedRequests.length) {
		console.error(`unprefixed requests: ${[...new Set(unprefixedRequests)].join(', ')}`);
	}
	if (consoleErrors.length) {
		console.error(`console errors: ${consoleErrors.slice(0, 10).join(' | ')}`);
	}
	for (const name of [nginxName, adminName, echoName, postgresName]) {
		try {
			const logs = execFileSync('docker', ['logs', '--tail', '40', name], {
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			if (logs.trim()) console.error(`--- ${name} logs (tail 40) ---\n${logs}`);
		} catch {
			// container may not exist
		}
	}
} finally {
	// 任何一步失败也要关浏览器，避免残留 chromium 进程；
	// 容器/网络/临时目录同理，全部在 stopStack 里兜底。
	if (browser) {
		await browser.close().catch(() => {});
		browser = null;
	}
	await stopStack();
}

if (exitCode !== 0) process.exit(exitCode);
