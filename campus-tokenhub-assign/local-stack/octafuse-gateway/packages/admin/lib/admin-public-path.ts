/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台公网路径边界（design D4）。
 *
 * 唯一职责：把「浏览器看到的前缀」与「Node 收到的根路径」隔离开。
 * - 本模块只影响浏览器侧（Vite base、Router basename、API/资源/WS 地址）；
 * - Node 入站路由不读取本配置，nginx 已剥离前缀；
 * - 纯函数，不导入 React / Next / 文件系统，可在构建脚本与浏览器共用。
 */

export const ADMIN_UI_PUBLIC_PATH_ENV = 'ADMIN_UI_PUBLIC_PATH';

/** 协议绝对地址（`https:`、`wss:`）或协议相对地址（`//host`）。 */
const EXTERNAL_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

function invalid(reason: string, raw: string | null | undefined): never {
	throw new Error(`${ADMIN_UI_PUBLIC_PATH_ENV} ${reason}: ${JSON.stringify(raw ?? '')}`);
}

/**
 * 规范化部署前缀：允许空前缀（根路径部署），否则必须是单个根相对 pathname。
 * 拒绝协议、host、query、hash、反斜杠、空段与 `.`/`..` 段，最后去掉尾斜杠。
 */
export function normalizeAdminUiPublicPath(raw?: string | null): string {
	const value = (raw ?? '').trim();
	if (!value) return '';
	if (!value.startsWith('/')) invalid('must be a root-relative pathname', raw);
	if (value.startsWith('//')) invalid('must not start with "//"', raw);
	if (value === '/') invalid('must not be "/" for a prefixed deployment', raw);
	if (/[?#\s\\]/.test(value)) invalid('must not contain query, hash, whitespace or backslashes', raw);
	if (value.includes('//')) invalid('must not contain empty path segments', raw);
	if (value.split('/').some((segment) => segment === '.' || segment === '..')) {
		invalid('must not contain dot segments', raw);
	}
	return value.replace(/\/+$/, '');
}

/**
 * 把站点路径拼到公网前缀下。
 * - 空前缀：原样返回；
 * - 外部/协议相对地址：不改写；
 * - 前缀自身的尾斜杠先归一，避免 `base + '/'` 产生双斜杠；
 * - 已带同一前缀（含相似名但非边界）：不重复补前缀（`/tokenhub/administrator` 不算已带）。
 */
export function joinAdminPublicPath(base: string, path: string): string {
	const target = path ?? '';
	const normalizedBase = base ? base.replace(/\/+$/, '') : '';
	if (!target) return normalizedBase || '/';
	if (EXTERNAL_URL_PATTERN.test(target)) return target;
	if (!normalizedBase) return target.startsWith('/') ? target : `/${target}`;
	if (target === normalizedBase || target.startsWith(`${normalizedBase}/`)) return target;
	return `${normalizedBase}${target.startsWith('/') ? target : `/${target}`}`;
}

export interface AdminPublicPath {
	/** 规范化后的前缀，根路径部署为空串。 */
	base: string;
	/** React Router `basename`，根部署为 `/`。 */
	routerBasename: string;
	/** Vite `base`，始终以 `/` 结尾。 */
	viteBase: string;
	api(path: string): string;
	asset(path: string): string;
	wsUrl(origin: string, path: string): string;
}

/** 构造浏览器侧路径工具；非法配置在构造期直接抛错，不进入运行期。 */
export function createAdminPublicPath(raw?: string | null): AdminPublicPath {
	const base = normalizeAdminUiPublicPath(raw);
	return {
		base,
		routerBasename: base || '/',
		viteBase: base ? `${base}/` : '/',
		api: (path: string) => joinAdminPublicPath(base, path),
		asset: (path: string) => joinAdminPublicPath(base, path),
		wsUrl: (origin: string, path: string) =>
			`${origin.replace(/\/+$/, '')}${joinAdminPublicPath(base, path)}`,
	};
}
