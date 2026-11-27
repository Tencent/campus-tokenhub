/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 调试台实时 WebSocket 对外路径。
 *
 * - `PLAYGROUND_REALTIME_PATH`：Node/Worker 内部拦截的根路径（nginx 已剥离公网前缀）；
 * - `PLAYGROUND_REALTIME_PUBLIC_PATH`：浏览器实际连接的路径（含公网前缀）；
 * - `playgroundRealtimePublicUrl`：把页面 origin 转成 ws/wss 并拼上带前缀的路径。
 *
 * 前缀只来自构建期 `ADMIN_UI_PUBLIC_PATH`（`lib/admin-browser-path.ts`），
 * 不再读取 `ADMIN_BASE_PATH` / `NEXT_PUBLIC_ADMIN_BASE_PATH`。
 */
import { adminBrowserPaths, createAdminBrowserPaths } from './admin-browser-path';

export const PLAYGROUND_REALTIME_PATH = '/api/admin/playground/realtime';

/** 浏览器实际连接的实时通道路径（已含 basePath）。 */
export const PLAYGROUND_REALTIME_PUBLIC_PATH = adminBrowserPaths.api(PLAYGROUND_REALTIME_PATH);

/**
 * 拼出可直接交给 `new WebSocket()` 的绝对地址。
 * HTTP(S) origin 会转换成 WS(S)，调用方随后可继续追加 query。
 */
export function playgroundRealtimePublicUrl(origin: string, base?: string): string {
	const target =
		base === undefined
			? PLAYGROUND_REALTIME_PUBLIC_PATH
			: createAdminBrowserPaths(base).api(PLAYGROUND_REALTIME_PATH);
	const wsOrigin = /^https?:/i.test(origin) ? origin.replace(/^http/i, 'ws') : origin;
	return `${wsOrigin.replace(/\/+$/, '')}${target}`;
}
