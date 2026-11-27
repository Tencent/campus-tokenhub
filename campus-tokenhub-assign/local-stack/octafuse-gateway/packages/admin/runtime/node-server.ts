/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Admin Node HTTP 入口（design D2/D7）。
 *
 * 生产与开发共用同一台 http server：
 * 1. Upgrade 仍由现有 realtime 处理器在根路径独占；
 * 2. `/api/**` 与未迁移的 Next 页面交给标准 Next 生产 handler（保留 cookies() 上下文）；
 * 3. dashboard / users/:id 等已迁移页面由 UI dispatch 返回 Vite 产物；
 * 4. 静态资源/public 缺失返回 404，未知方法返回 405。
 *
 * 生产模式使用正常 `.next` 产物 + 正常 `next.config.mjs` 启动自定义 server，
 * 不再注入 `__NEXT_PRIVATE_STANDALONE_CONFIG`，也不依赖 `.next/standalone`。
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import next from 'next';
import { dispatchAdminUiRequest } from '../lib/admin-ui-dispatch';
import { maybeStartPortalUsageWorker } from '../lib/portal-usage/worker';
import { maybeStartRequestContentMaintenanceWorker } from '../lib/request-content/maintenance';
import {
	handleAdminNodeRealtimeUpgrade,
	incomingMessageToFetchRequest,
} from '../lib/admin-node-realtime';
import { PLAYGROUND_REALTIME_PATH } from '../lib/playground-realtime-path';
import {
	createPlaygroundNodeWebSocketServer,
	type NodeWebSocket,
} from '../lib/playground-node-realtime';

type NextUpgradeHandler = (
	req: IncomingMessage,
	socket: Duplex,
	head: Buffer,
) => void | Promise<void>;

type NextServerWithUpgrade = ReturnType<typeof next> & {
	prepare: () => Promise<void>;
	getRequestHandler: () => (req: IncomingMessage, res: ServerResponse) => unknown;
	getUpgradeHandler?: () => NextUpgradeHandler;
	/**
	 * Next 自定义 server 在第一次 HTTP 请求时会给同一台 http.Server 再挂一个 upgrade 监听，
	 * 并对已匹配的 App Router 路径 `socket.end()`。调试台实时 WS 必须抢先独占 upgrade，
	 * 并把这个标记设为 true，避免 101 之后被 Next 拆成 1006。
	 */
	didWebSocketSetup?: boolean;
	upgradeHandler?: NextUpgradeHandler;
};

/** `runtime/node-server.ts` 与 `node-server-dist/node-server.mjs` 都在管理台目录下一层。 */
function resolveAdminDir(): string {
	return join(dirname(fileURLToPath(import.meta.url)), '..');
}

async function handlePlaygroundUpgrade(request: IncomingMessage, client: NodeWebSocket): Promise<void> {
	try {
		const response = await handleAdminNodeRealtimeUpgrade(
			incomingMessageToFetchRequest(request),
			client,
		);
		if (response.headers.get('x-octafuse-realtime-upgrade') === '1') {
			client.resume();
			return;
		}
		const message = (await response.clone().text()).trim() || `HTTP ${response.status}`;
		console.warn(`[octafuse-admin] playground realtime upgrade rejected: ${message.slice(0, 300)}`);
		if (client.readyState !== 3) client.close(1008, message.slice(0, 123));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error('[octafuse-admin] playground realtime upgrade failed', error);
		if (client.readyState !== 3) client.close(1011, message.slice(0, 123));
	} finally {
		try {
			client.resume();
		} catch {
			// ignore
		}
	}
}

function sendText(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
	res.writeHead(status, {
		'Content-Type': 'text/plain; charset=utf-8',
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(message);
}

function sendFile(
	req: IncomingMessage,
	res: ServerResponse,
	filePath: string,
	contentType: string,
	cacheControl: string,
): void {
	let size: number;
	try {
		size = statSync(filePath).size;
	} catch {
		sendText(res, 404, 'Not Found');
		return;
	}
	res.writeHead(200, {
		'Content-Type': contentType,
		'Content-Length': String(size),
		'Cache-Control': cacheControl,
		'X-Content-Type-Options': 'nosniff',
	});
	if (req.method === 'HEAD') {
		res.end();
		return;
	}
	const stream = createReadStream(filePath);
	stream.on('error', (error) => {
		console.error('[octafuse-admin] static file stream failed', error);
		if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
		else res.destroy();
	});
	stream.pipe(res);
}

export async function startAdminNodeServer(
	port = Number(process.env.PORT ?? 8789),
	hostname = process.env.HOSTNAME?.trim() || '0.0.0.0',
): Promise<void> {
	const dev = process.env.NODE_ENV !== 'production';
	const dir = resolveAdminDir();
	const app = next({ dev, hostname, port, dir }) as NextServerWithUpgrade;
	await app.prepare();
	app.didWebSocketSetup = true;
	const handle = app.getRequestHandler();
	const nextUpgrade =
		typeof app.upgradeHandler === 'function'
			? app.upgradeHandler
			: typeof app.getUpgradeHandler === 'function'
				? app.getUpgradeHandler()
				: null;
	const websocketServer = createPlaygroundNodeWebSocketServer();
	const uiDistDir = join(dir, 'ui-dist');
	const publicDir = join(dir, 'public');

	const server = createServer((req, res) => {
		let pathname = '/';
		try {
			pathname = new URL(req.url ?? '/', 'http://admin.local').pathname;
		} catch {
			sendText(res, 400, 'Bad Request');
			return;
		}

		const result = dispatchAdminUiRequest({
			method: req.method ?? 'GET',
			pathname,
			uiDistDir,
			publicDir,
		});

		switch (result.kind) {
			case 'next-api':
			case 'next-page':
				void Promise.resolve(handle(req, res)).catch((error: unknown) => {
					console.error('[octafuse-admin] Next handler failed', error);
					if (!res.headersSent) sendText(res, 500, 'Internal Server Error');
					else res.destroy();
				});
				return;
			case 'ui-html':
				sendFile(req, res, result.filePath, 'text/html; charset=utf-8', 'no-store');
				return;
			case 'static':
				sendFile(req, res, result.filePath, result.contentType, result.cacheControl);
				return;
			case 'method-not-allowed':
				sendText(res, 405, 'Method Not Allowed', { Allow: result.allow });
				return;
			case 'not-found':
				sendText(res, 404, result.message);
				return;
		}
	});

	server.on('upgrade', (request, socket, head) => {
		const pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`).pathname;
		// nginx 已剥离公网前缀，Node 只看到根 realtime 路径。
		if (pathname === PLAYGROUND_REALTIME_PATH) {
			websocketServer.handleUpgrade(request, socket, head, (client) => {
				// 同一拍 pause 会卡住 101 刷出，浏览器会一直停在 CONNECTING，调试台只剩「停止」和空响应。
				setImmediate(() => {
					if (client.readyState === 3) return;
					client.pause();
					void handlePlaygroundUpgrade(request, client);
				});
			});
			return;
		}
		if (nextUpgrade) {
			void nextUpgrade(request, socket, head);
			return;
		}
		socket.destroy();
	});

	await new Promise<void>((resolve) => {
		server.listen(port, hostname, () => resolve());
	});
	const displayHost = hostname === '0.0.0.0' ? '127.0.0.1' : hostname;
	console.log(`[octafuse-admin] Node listening on http://${displayHost}:${port} (UI + Next API)`);
	// 门户用量补算（独立模块；PORTAL_USAGE_WORKER=off 可关闭）
	maybeStartPortalUsageWorker();
	// 正文分区维护（独立模块；REQUEST_CONTENT_MAINTENANCE=off 可关闭）
	maybeStartRequestContentMaintenanceWorker();
}

function isDirectNodeServerEntry(): boolean {
	const argvPath = process.argv[1];
	if (argvPath) {
		try {
			if (import.meta.url === pathToFileURL(argvPath).href) return true;
		} catch {
			// ignore invalid argv paths from loaders
		}
		if (/(?:^|[/\\])node-server\.(ts|mjs|js)$/.test(argvPath)) return true;
	}
	return process.argv.some((arg) => /(?:^|[/\\])node-server\.(ts|mjs|js)$/.test(arg));
}

if (isDirectNodeServerEntry()) {
	startAdminNodeServer().catch((err) => {
		console.error(err);
		process.exit(1);
	});
}
