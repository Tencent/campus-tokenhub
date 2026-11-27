/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 首组过渡用的 Next `next/navigation` 兼容适配器（design D3）。
 *
 * 仅实现当前共享组件（Sidebar / AdminShell / DocumentTitle / LocaleSwitcher /
 * 页面 state hooks）实际使用的 API，底层全部委托 React Router：
 * - `usePathname` / `useParams` / `useSearchParams` 读取当前路由；
 * - `useRouter().push/replace/back/forward` 走客户端 history 并保留 `{ scroll:false }`；
 * - `refresh` 不伪造 RSC，只广播一次客户端刷新事件（`App` 据此重读 locale cookie）。
 *
 * 不伪造 Next RSC/Flight 运行时；Next 保留页面仍由 Next 自己渲染。
 */
import { useCallback, useMemo } from 'react';
import {
	useLocation,
	useNavigate,
	useParams as useRouterParams,
	useSearchParams as useRouterSearchParams,
} from 'react-router-dom';

/** `router.refresh()` 的客户端等价信号：让 Provider 重新读取 locale 等派生状态。 */
export const ADMIN_UI_REFRESH_EVENT = 'octafuse-admin:refresh';

export interface AdminUiNavigateOptions {
	/** 与 Next 一致：`scroll: false` 表示保持当前滚动位置。 */
	scroll?: boolean;
}

export function usePathname(): string {
	return useLocation().pathname;
}

export function useParams(): Readonly<Record<string, string | undefined>> {
	return useRouterParams();
}

/** 与 `next/navigation` 一致：返回单个只读 search params，而不是 `[value, setter]` 元组。 */
export function useSearchParams(): Readonly<URLSearchParams> {
	const [searchParams] = useRouterSearchParams();
	return searchParams;
}

export interface AdminUiRouter {
	push: (href: string, options?: AdminUiNavigateOptions) => void;
	replace: (href: string, options?: AdminUiNavigateOptions) => void;
	back: () => void;
	forward: () => void;
	refresh: () => void;
	prefetch: () => void;
}

export function useRouter(): AdminUiRouter {
	const navigate = useNavigate();
	const push = useCallback(
		(href: string, options?: AdminUiNavigateOptions) => {
			navigate(href, { preventScrollReset: options?.scroll === false });
		},
		[navigate],
	);
	const replace = useCallback(
		(href: string, options?: AdminUiNavigateOptions) => {
			navigate(href, { replace: true, preventScrollReset: options?.scroll === false });
		},
		[navigate],
	);
	return useMemo(
		() => ({
			push,
			replace,
			back: () => navigate(-1),
			forward: () => navigate(1),
			refresh: () => {
				window.dispatchEvent(new Event(ADMIN_UI_REFRESH_EVENT));
			},
			prefetch: () => {},
		}),
		[navigate, push, replace],
	);
}

/** Next 的服务端 `redirect()` 不允许进入浏览器 bundle；命中即暴露迁移遗漏。 */
export function redirect(path?: string): never {
	throw new Error(
		`next/navigation redirect() is not available in the admin UI bundle (target: ${path ?? 'unknown'})`,
	);
}
