/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 路由模块加载失败恢复（design D5）。
 *
 * 行为约束：
 * - 页面模块（lazy chunk）加载失败：一次有界版本核对 + 明确重试；
 * - 页面内部渲染错误：只说明页面出错，不做版本核对、不引导刷新；
 * - 确认 build ID 变化 → 明确说明「新版本可用」并给出刷新提示；
 * - 版本相同 / 无法核对 / metadata 缺失 → 只说明资源加载失败，不谎称新版本；
 * - 用户明确重试仍失败 → 给出未保存状态风险提示，只有用户主动点击才刷新；
 * - 拒绝刷新不刷新、不循环，重试入口与侧边栏导航保持可用；
 * - 普通导航与资源重试本身都不刷新 document。
 *
 * 该面板刻意不依赖 next-intl：模块加载失败时 Provider 可能尚未装配或已损坏，
 * 恢复入口必须是最小依赖的纯文本 UI。
 */
import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react';
import { ADMIN_UI_BUILD_ID } from '@/lib/admin-build-id';
import { checkAdminUiVersion, type AdminUiVersionStatus } from '@/lib/admin-ui-version';
import { ADMIN_UI_PUBLIC_BASE } from './public-path';

export type AdminVersionChecker = typeof checkAdminUiVersion;

/** `module`：`import()` 失败；`page`：页面组件自身抛错。 */
export type RouteLoadCause = 'module' | 'page';

/**
 * 标记「本次错误来自路由模块 import()」。
 * 用 WeakSet 而不是 ref：错误对象只存活到边界处理完，不持有任何页面数据。
 */
const MODULE_LOAD_FAILURES = new WeakSet<object>();

export function markModuleLoadFailure(error: unknown): void {
	if (typeof error === 'object' && error !== null) MODULE_LOAD_FAILURES.add(error);
}

function causeOf(error: unknown): RouteLoadCause {
	return typeof error === 'object' && error !== null && MODULE_LOAD_FAILURES.has(error)
		? 'module'
		: 'page';
}

/** 刷新当前地址（保留公网前缀、query 与 hash），只由用户明确点击触发。 */
export function reloadCurrentAdminPage(): void {
	window.location.reload();
}

export interface RouteLoadErrorProps {
	routeId: string;
	/** 0 = 首次失败（做一次版本核对）；>=1 = 已按用户要求重试仍失败。 */
	attempt: number;
	onRetry: () => void;
	cause?: RouteLoadCause;
	checkVersion?: AdminVersionChecker;
	reload?: () => void;
	base?: string;
	currentBuildId?: string;
}

const panelClass =
	'flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-sm text-gray-600';
const titleClass = 'text-lg font-semibold text-gray-900';
const riskClass = 'max-w-md text-xs text-amber-700';
const buttonRowClass = 'mt-1 flex flex-wrap items-center justify-center gap-2';
const primaryButtonClass =
	'rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500';
const secondaryButtonClass =
	'rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500';

function versionReason(version: AdminUiVersionStatus): string {
	if (version === 'same') {
		return 'The server is serving the same version, so this looks like a failed resource download.';
	}
	return 'The deployed version could not be verified.';
}

export function RouteLoadError({
	routeId,
	attempt,
	onRetry,
	cause = 'module',
	checkVersion = checkAdminUiVersion,
	reload = reloadCurrentAdminPage,
	base = ADMIN_UI_PUBLIC_BASE,
	currentBuildId = ADMIN_UI_BUILD_ID,
}: RouteLoadErrorProps) {
	const [version, setVersion] = useState<AdminUiVersionStatus | 'checking'>('checking');
	const [promptDismissed, setPromptDismissed] = useState(false);

	useEffect(() => {
		// 页面内部错误与版本无关；重试失败也不重复核对，避免形成请求循环。
		if (cause !== 'module' || attempt > 0) return;
		let cancelled = false;
		void checkVersion({ currentBuildId, base }).then((result) => {
			if (!cancelled) setVersion(result.status);
		});
		return () => {
			cancelled = true;
		};
	}, [attempt, base, cause, checkVersion, currentBuildId]);

	if (cause === 'page') {
		return (
			<div className={panelClass} role="alert" data-admin-route-load-error={routeId}>
				<h1 className={titleClass}>This page failed to render</h1>
				<p className="max-w-md">
					An unexpected error occurred while rendering this page. Retrying reloads only this
					page&apos;s component.
				</p>
				<div className={buttonRowClass}>
					<button type="button" onClick={onRetry} className={primaryButtonClass}>
						Try again
					</button>
				</div>
			</div>
		);
	}

	const hasConfirmedNewVersion = attempt === 0 && version === 'changed';
	const showRefreshPrompt = hasConfirmedNewVersion || attempt > 0;

	const heading = hasConfirmedNewVersion
		? 'A new admin UI version is available'
		: attempt > 0
			? 'This page still failed to load after a retry'
			: 'This page failed to load';

	const reason = hasConfirmedNewVersion
		? `The server is serving a different build than this tab (${routeId}).`
		: attempt > 0
			? 'The page resources could not be loaded, and the deployed version is unconfirmed.'
			: version === 'checking'
				? 'Checking the deployed version…'
				: versionReason(version);

	return (
		<div className={panelClass} role="alert" data-admin-route-load-error={routeId}>
			<h1 className={titleClass}>{heading}</h1>
			<p className="max-w-md">{reason}</p>
			{showRefreshPrompt && !promptDismissed ? (
				<p className={riskClass}>
					Refreshing reloads the current admin URL and discards any unsaved changes on this page.
				</p>
			) : null}
			{showRefreshPrompt && promptDismissed ? (
				<p className="max-w-md text-xs text-gray-500">
					Refresh cancelled. You can keep using the sidebar or try loading this page again.
				</p>
			) : null}
			<div className={buttonRowClass}>
				{hasConfirmedNewVersion ? null : (
					<button type="button" onClick={onRetry} className={primaryButtonClass}>
						Try again
					</button>
				)}
				{showRefreshPrompt && !promptDismissed ? (
					<button
						type="button"
						onClick={reload}
						className={hasConfirmedNewVersion ? primaryButtonClass : secondaryButtonClass}
					>
						Refresh page
					</button>
				) : null}
				{showRefreshPrompt && !promptDismissed ? (
					<button
						type="button"
						onClick={() => setPromptDismissed(true)}
						className={secondaryButtonClass}
					>
						Not now
					</button>
				) : null}
			</div>
		</div>
	);
}

/** App shell / Provider 级致命错误：不自动刷新，只给用户一个明确入口。 */
export function AdminFatalError({ message }: { message?: string }) {
	return (
		<div className={panelClass} role="alert">
			<h1 className={titleClass}>The admin console failed to start</h1>
			<p className="max-w-md">{message ?? 'An unexpected error occurred while starting the admin UI.'}</p>
			<p className={riskClass}>Reloading the page may discard unsaved changes.</p>
			<div className={buttonRowClass}>
				<button type="button" onClick={reloadCurrentAdminPage} className={primaryButtonClass}>
					Reload page
				</button>
			</div>
		</div>
	);
}

export interface RouteLoadBoundaryProps {
	routeId: string;
	attempt: number;
	onRetry: () => void;
	children: ReactNode;
	/** 测试注入的版本核对实现；生产走 `checkAdminUiVersion`。 */
	checkVersion?: AdminVersionChecker;
	reload?: () => void;
	base?: string;
	currentBuildId?: string;
}

interface RouteLoadBoundaryState {
	failed: boolean;
	error: unknown;
}

/**
 * 仅包裹单个页面模块的 React 错误边界。
 * 调用方以 `key={`${routeId}:${attempt}`}` 重挂载，配合新的 lazy 实例实现「重置可重试」。
 */
export class RouteLoadBoundary extends Component<RouteLoadBoundaryProps, RouteLoadBoundaryState> {
	state: RouteLoadBoundaryState = { failed: false, error: null };

	static getDerivedStateFromError(error: unknown): RouteLoadBoundaryState {
		return { failed: true, error };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		// 只记录失败本身；不把错误详情渲染给用户，也不上报凭证/会话数据。
		console.error(`[octafuse-admin] route module failed: ${this.props.routeId}`, error, info);
	}

	render(): ReactNode {
		if (!this.state.failed) return this.props.children;
		const { routeId, attempt, onRetry, checkVersion, reload, base, currentBuildId } = this.props;
		return (
			<RouteLoadError
				routeId={routeId}
				attempt={attempt}
				onRetry={onRetry}
				cause={causeOf(this.state.error)}
				checkVersion={checkVersion}
				reload={reload}
				base={base}
				currentBuildId={currentBuildId}
			/>
		);
	}
}

/** 顶层兜底：Provider/Shell 崩溃时避免整页白屏。 */
export class AdminAppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	componentDidCatch(error: unknown, info: ErrorInfo): void {
		console.error('[octafuse-admin] app shell failed', error, info);
	}

	render(): ReactNode {
		return this.state.failed ? <AdminFatalError /> : this.props.children;
	}
}
