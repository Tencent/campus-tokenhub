/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 浏览器路由适配器（design D3/D5）。
 *
 * 这里是全项目唯一的 React/lazy 页面绑定处：Node 匹配器只消费
 * `lib/admin-ui-route-manifest.ts`，绝不导入本文件。路由表本身由 manifest
 * 生成，避免浏览器与 Node 各维护一份路径字符串。
 *
 * 2.3 起：
 * - 页面 loader 集中在 `ui/route-modules.ts`，并注册到路由预取器；
 * - 每个页面由独立的错误边界包裹，模块加载失败可显式重试（重建 lazy 实例）；
 * - 重试/点击都只拉取路由 chunk，不额外触发业务 API。
 */
import {
	lazy,
	Suspense,
	useCallback,
	useMemo,
	useState,
	type ComponentType,
	type LazyExoticComponent,
} from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ADMIN_UI_ROUTES } from '@/lib/admin-ui-route-manifest';
import { adminPrefetcher, resetAdminRoutePrefetch, type AdminRouteLoader } from './prefetch';
import { AdminFatalError, markModuleLoadFailure, RouteLoadBoundary } from './route-load-boundary';
import { ADMIN_UI_ROUTE_MODULES } from './route-modules';

// 只登记 loader；真正加载由 hover/focus/click 的明确意图驱动。
adminPrefetcher.register(ADMIN_UI_ROUTE_MODULES);

/**
 * 每个 `routeId@attempt` 只创建一个 lazy 实例。
 * React.lazy 会缓存已拒绝的 Promise，所以重试必须换一个全新实例；
 * 旧实例在创建新实例时一并删除，避免缓存无限增长。
 */
const LAZY_PAGE_CACHE = new Map<string, LazyExoticComponent<ComponentType>>();

function getLazyPage(
	routeId: string,
	load: AdminRouteLoader,
	attempt: number,
): LazyExoticComponent<ComponentType> {
	const key = `${routeId}@${attempt}`;
	const cached = LAZY_PAGE_CACHE.get(key);
	if (cached) return cached;
	for (const existing of Array.from(LAZY_PAGE_CACHE.keys())) {
		if (existing.startsWith(`${routeId}@`)) LAZY_PAGE_CACHE.delete(existing);
	}
	const page = lazy(load);
	LAZY_PAGE_CACHE.set(key, page);
	return page;
}

function PageFallback() {
	return (
		<div className="flex h-full items-center justify-center p-8 text-sm text-gray-500" role="status">
			Loading…
		</div>
	);
}

function UnknownRoute() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
			<h1 className="text-xl font-semibold text-gray-900">Not found</h1>
			<p className="text-sm text-gray-500">This admin page is not part of the migrated UI yet.</p>
		</div>
	);
}

export function RoutePage({ routeId, load }: { routeId: string; load: AdminRouteLoader }) {
	const [attempt, setAttempt] = useState(0);

	// 标记失败是否来自 `import()`：页面内部 render 错误不应被说成版本变化。
	const trackedLoad = useMemo<AdminRouteLoader>(
		() => async () => {
			try {
				return await load();
			} catch (error) {
				markModuleLoadFailure(error);
				throw error;
			}
		},
		[load],
	);

	// React.lazy 会缓存已拒绝的 Promise：重试必须换一个全新实例，因此这里刻意
	// 按 attempt 取缓存中的组件实例（实例本身在模块级创建，不会每次渲染重建）。
	const Page = getLazyPage(routeId, trackedLoad, attempt);

	const retry = useCallback(() => {
		resetAdminRoutePrefetch(routeId);
		setAttempt((value) => value + 1);
	}, [routeId]);

	return (
		<RouteLoadBoundary
			key={`${routeId}:${attempt}`}
			routeId={routeId}
			attempt={attempt}
			onRetry={retry}
		>
			<Suspense fallback={<PageFallback />}>
				{/* eslint-disable-next-line react-hooks/static-components -- 重试必须使用新 lazy 实例 */}
				<Page />
			</Suspense>
		</RouteLoadBoundary>
	);
}

export function AdminUiRoutes() {
	return (
		<Routes>
			{ADMIN_UI_ROUTES.map((route) => {
				if (route.kind === 'redirect') {
					return (
						<Route
							key={route.id}
							path={route.pattern}
							element={<Navigate to={route.redirectTo ?? '/dashboard'} replace />}
						/>
					);
				}
				const load = ADMIN_UI_ROUTE_MODULES[route.id];
				if (!load) {
					// 配置错误不 white-screen 整个 App：只在这一条路由上给出可读错误。
					return (
						<Route
							key={route.id}
							path={route.pattern}
							element={<AdminFatalError message={`Admin UI route "${route.id}" has no browser component binding`} />}
						/>
					);
				}
				return (
					<Route
						key={route.id}
						path={route.pattern}
						element={<RoutePage routeId={route.id} load={load} />}
					/>
				);
			})}
			<Route path="*" element={<UnknownRoute />} />
		</Routes>
	);
}
