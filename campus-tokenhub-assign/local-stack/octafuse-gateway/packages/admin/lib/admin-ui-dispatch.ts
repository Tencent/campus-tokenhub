/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 Node 请求分流（design D2 + 3.1 安全边界）。
 *
 * 顺序固定：
 * 1. `/api` 边界内所有方法交回无 basePath 的 Next handler；
 * 2. `/_next/**` 原样交回 Next；
 * 3. 非读方法对已知 UI/资源返回 405，不落 HTML 200；
 * 4. UI 静态资源只认显式清单：`/assets/**`、`/index.html`、`/ui-version.json`
 *    与 `public/` 下的真实目录；缺失返回 404，禁止 index.html fallback；
 * 5. GET/HEAD 命中纯数据 route manifest 的页面返回 SPA index.html；
 * 6. 其余路径交回 Next，由 Next 返回它自己的 404。
 *
 * 本模块为 Node-only：只依赖 manifest 与 `node:fs`/`node:path`，
 * 不得导入 React、React Router 或 `ui/*` 浏览器适配器。
 */
import { readdirSync, statSync, type Dirent } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { matchAdminUiRoute } from './admin-ui-route-manifest';

export type AdminUiDispatchResult =
	| { kind: 'next-api' }
	| { kind: 'next-page' }
	| { kind: 'ui-html'; filePath: string }
	| { kind: 'static'; filePath: string; contentType: string; cacheControl: string }
	| { kind: 'not-found'; message: string }
	| { kind: 'method-not-allowed'; allow: 'GET, HEAD' };

export interface AdminUiDispatchInput {
	method: string;
	pathname: string;
	uiDistDir: string;
	publicDir: string;
}

const READ_METHODS = new Set(['GET', 'HEAD']);

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp',
	'.gif': 'image/gif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath: string): string {
	return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 把请求路径限制在指定根目录内。
 * 使用 `resolve` 归一化 `..` 后再校验前缀，拒绝目录穿越与 NUL 字节。
 */
function resolveInside(root: string, requestPath: string): string | null {
	if (requestPath.includes('\0')) return null;
	const rootPath = resolve(root);
	const candidate = resolve(rootPath, `.${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`);
	if (candidate !== rootPath && !candidate.startsWith(`${rootPath}${sep}`)) return null;
	return candidate;
}

function isFile(filePath: string | null): filePath is string {
	if (!filePath) return false;
	try {
		return statSync(filePath).isFile();
	} catch {
		return false;
	}
}

function isApiPath(pathname: string): boolean {
	return pathname === '/api' || pathname.startsWith('/api/');
}

function isAssetPath(pathname: string): boolean {
	return pathname === '/assets' || pathname.startsWith('/assets/');
}

/** Next 自己的构建资源与内部路径必须原样交给 Next，不能被 UI 静态判定拦下。 */
function isNextInternalPath(pathname: string): boolean {
	return pathname === '/_next' || pathname.startsWith('/_next/');
}

/**
 * 管理台自己的静态命名空间：UI 构建的 `assets` 与 `public/` 下的真实目录。
 * 只有这些命名空间内缺失的文件才算 404；其余路径（含 `/_next/**`、未来 Next 路由）
 * 一律交给 Next，避免按扩展名对全站路径做静态推断。
 */
function isUnderPublicNamespace(pathname: string, publicDir: string): boolean {
	let entries: Dirent[];
	try {
		entries = readdirSync(publicDir, { withFileTypes: true });
	} catch {
		return false;
	}
	return entries.some(
		(entry) =>
			entry.isDirectory() &&
			(pathname === `/${entry.name}` || pathname.startsWith(`/${entry.name}/`)),
	);
}

/**
 * UI 构建根目录只暴露显式列出的文件。
 * Vite 的 `.vite/manifest.json` 等构建内部文件不属于交付面。
 */
const UI_ROOT_FILES = new Map<string, { contentType: string; cacheControl: string }>([
	['/index.html', { contentType: 'text/html; charset=utf-8', cacheControl: 'no-store' }],
	['/ui-version.json', { contentType: 'application/json; charset=utf-8', cacheControl: 'no-store' }],
]);

function isUiRootFile(pathname: string): boolean {
	return UI_ROOT_FILES.has(pathname);
}

/** Vite 构建内部命名空间：明确拒绝，不交给 Next 当成页面。 */
function isUiBuildInternalPath(pathname: string): boolean {
	return pathname === '/.vite' || pathname.startsWith('/.vite/');
}

function staticResult(pathname: string, input: AdminUiDispatchInput): AdminUiDispatchResult | null {
	if (isAssetPath(pathname)) {
		const filePath = resolveInside(input.uiDistDir, pathname);
		if (isFile(filePath)) {
			return {
				kind: 'static',
				filePath,
				contentType: contentTypeFor(filePath),
				cacheControl: 'public, max-age=31536000, immutable',
			};
		}
		return { kind: 'not-found', message: `Missing UI asset: ${pathname}` };
	}

	// 根文件走显式清单：命中清单但文件缺失要给出明确错误，不能落 HTML。
	const rootFile = UI_ROOT_FILES.get(pathname);
	if (rootFile) {
		const filePath = resolveInside(input.uiDistDir, pathname);
		if (isFile(filePath)) {
			return { kind: 'static', filePath, ...rootFile };
		}
		return {
			kind: 'not-found',
			message:
				pathname === '/ui-version.json'
					? 'UI version metadata is missing'
					: 'UI entry index.html is missing',
		};
	}

	if (isUiBuildInternalPath(pathname)) {
		return { kind: 'not-found', message: `Build-internal file is not served: ${pathname}` };
	}

	// public/ 下的真实目录：存在即返回，缺失即 404。
	if (isUnderPublicNamespace(pathname, input.publicDir)) {
		const filePath = resolveInside(input.publicDir, pathname);
		if (isFile(filePath)) {
			return {
				kind: 'static',
				filePath,
				contentType: contentTypeFor(filePath),
				cacheControl: 'public, max-age=3600',
			};
		}
		return { kind: 'not-found', message: `Missing static file: ${pathname}` };
	}

	return null;
}

export function dispatchAdminUiRequest(input: AdminUiDispatchInput): AdminUiDispatchResult {
	const method = input.method.toUpperCase();

	let pathname: string;
	try {
		pathname = decodeURI(input.pathname);
	} catch {
		return { kind: 'not-found', message: 'Malformed request path' };
	}
	if (!pathname.startsWith('/')) {
		return { kind: 'not-found', message: 'Malformed request path' };
	}
	// 解码后再拒绝点段与反斜杠，避免把 `..` 交给文件查找或 Next 路由。
	if (
		pathname.includes('\\') ||
		pathname
			.split('/')
			.some((segment) => segment === '.' || segment === '..')
	) {
		return { kind: 'not-found', message: 'Malformed request path' };
	}

	// 1. API 永远优先：未知 API 也必须由 Next 保持 404/405/鉴权语义。
	if (isApiPath(pathname)) {
		return { kind: 'next-api' };
	}

	// 2. Next 构建资源（`/_next/**`）与内部路径原样交给 Next，不能被 UI 静态判定拦下。
	if (isNextInternalPath(pathname)) {
		return { kind: 'next-page' };
	}

	// 3. UI 与资源只允许读取；写方法不得被 SPA fallback 变成 HTML 200。
	//    未知路径的写请求仍交 Next 自行判定，避免吞掉未来的非 /api 处理器。
	if (!READ_METHODS.has(method)) {
		if (
			matchAdminUiRoute(pathname) ||
			isAssetPath(pathname) ||
			isUiRootFile(pathname) ||
			isUiBuildInternalPath(pathname) ||
			isUnderPublicNamespace(pathname, input.publicDir)
		) {
			return { kind: 'method-not-allowed', allow: 'GET, HEAD' };
		}
		return { kind: 'next-page' };
	}

	// 4. 静态资源/public：显式清单，缺失即 404。
	const staticHit = staticResult(pathname, input);
	if (staticHit) return staticHit;

	// 5. 已知 UI 页面统一返回 SPA 入口（客户端 Router 决定具体页面）。
	if (matchAdminUiRoute(pathname)) {
		const indexPath = resolveInside(input.uiDistDir, '/index.html');
		if (!isFile(indexPath)) {
			return { kind: 'not-found', message: 'UI entry index.html is missing' };
		}
		return { kind: 'ui-html', filePath: indexPath };
	}

	// 5/6. 未迁移页面与其余路径交给 Next；Next 自己负责保留页面或 404。
	return { kind: 'next-page' };
}
