/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 浏览器侧公网地址（design D4）。
 *
 * 由构建期 `ADMIN_UI_PUBLIC_PATH` 注入 `__ADMIN_UI_PUBLIC_BASE__`（Vite `define`），
 * 根部署为 `''`。用 `typeof` 读取，未注入的环境（Next 编译、Node bundle）安全回落根路径。
 *
 * 唯一职责是把「浏览器请求地址」放到公网前缀下；Node 入站路由不读取本模块。
 * 纯函数，不导入 React / Next / 文件系统 / secret。
 */
import { createAdminPublicPath } from './admin-public-path';

declare const __ADMIN_UI_PUBLIC_BASE__: string | undefined;

export interface AdminBrowserPaths {
	/** 规范化前缀，根部署为空串。 */
	base: string;
	/** React Router `basename`，根部署为 `/`。 */
	routerBasename: string;
	/** 浏览器 API/页面请求地址。 */
	api: (target: string) => string;
	/** 静态资源地址（同样规则，保留给需要显式拼资源 URL 的场景）。 */
	asset: (target: string) => string;
	/** 实时通道绝对地址（origin 由调用方给出）。 */
	wsUrl: (origin: string, target: string) => string;
}

export function createAdminBrowserPaths(rawBase?: string | null): AdminBrowserPaths {
	const path = createAdminPublicPath(rawBase);
	return {
		base: path.base,
		routerBasename: path.routerBasename,
		api: path.api,
		asset: path.asset,
		wsUrl: path.wsUrl,
	};
}

const injectedBase =
	typeof __ADMIN_UI_PUBLIC_BASE__ === 'string' ? __ADMIN_UI_PUBLIC_BASE__ : '';

export const adminBrowserPaths = createAdminBrowserPaths(injectedBase);

/** 最常用入口：`fetch(adminApiPath('/api/auth/check'))`。 */
export const adminApiPath = adminBrowserPaths.api;
