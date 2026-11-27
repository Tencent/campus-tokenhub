/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 路由资源预取（design D5）。
 *
 * 约束：
 * - 只由菜单 hover / keyboard focus 的明确意图触发，菜单可见本身不批量预取；
 * - 推测加载并发上限默认 2；
 * - 与点击共用去重：同一 route 只加载一次，点击优先于排队中的推测；
 * - 读取到 `saveData` 时关闭推测加载，但点击加载不受影响；
 * - 失败记录可被显式清理并重试，不无限重试、不缓存已拒绝的 Promise。
 *
 * 本模块不导入 React / React Router / 页面组件，可被 Next 侧组件安全引用。
 */
import type { ComponentType } from 'react';

export type AdminRouteLoader = () => Promise<{ default: ComponentType }>;

export interface AdminPrefetcherOptions {
	maxConcurrent?: number;
	/** 返回 true 时关闭推测加载（`navigator.connection.saveData`）。 */
	isDataSaving?: () => boolean;
}

export type PrefetchTrigger = 'speculative' | 'click';

export function createAdminPrefetcher(options: AdminPrefetcherOptions = {}) {
	const maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
	const isDataSaving = options.isDataSaving ?? defaultIsDataSaving;
	const loaders = new Map<string, AdminRouteLoader>();
	const loaded = new Set<string>();
	const failed = new Set<string>();
	const inflight = new Map<string, Promise<void>>();
	const queue: string[] = [];
	let active = 0;

	function defaultIsDataSaving(): boolean {
		if (typeof navigator === 'undefined') return false;
		const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
		return connection?.saveData === true;
	}

	function start(id: string): void {
		const loader = loaders.get(id);
		if (!loader) return;
		active += 1;
		const promise = loader()
			.then(() => {
				loaded.add(id);
				failed.delete(id);
			})
			.catch(() => {
				// 只记录失败，不缓存已拒绝的 Promise；重试由 reset 显式触发。
				failed.add(id);
			})
			.finally(() => {
				active -= 1;
				inflight.delete(id);
				drain();
			});
		inflight.set(id, promise);
	}

	function drain(): void {
		while (active < maxConcurrent && queue.length > 0) {
			const next = queue.shift()!;
			if (loaded.has(next) || failed.has(next) || inflight.has(next)) continue;
			start(next);
		}
	}

	function register(next: Record<string, AdminRouteLoader>): void {
		for (const [id, loader] of Object.entries(next)) loaders.set(id, loader);
	}

	function prefetch(id: string, trigger: PrefetchTrigger = 'speculative'): void {
		// 点击是一次明确的用户操作：清理失败记录后重新加载，避免失败的预取挡住导航。
		if (trigger === 'click') failed.delete(id);
		if (!loaders.has(id) || loaded.has(id) || failed.has(id) || inflight.has(id)) return;
		if (trigger === 'speculative') {
			if (isDataSaving()) return;
			if (queue.includes(id)) return;
			queue.push(id);
			drain();
			return;
		}
		// 点击优先：移出推测队列并立刻占用一个并发槽（最多借用 1 个额外槽位）。
		const index = queue.indexOf(id);
		if (index >= 0) queue.splice(index, 1);
		if (active >= maxConcurrent) {
			start(id);
			return;
		}
		start(id);
	}

	function reset(id?: string): void {
		if (id === undefined) {
			failed.clear();
			queue.length = 0;
			return;
		}
		failed.delete(id);
		const index = queue.indexOf(id);
		if (index >= 0) queue.splice(index, 1);
	}

	return {
		register,
		prefetch,
		reset,
		isLoaded: (id: string) => loaded.has(id),
		isFailed: (id: string) => failed.has(id),
		pendingCount: () => queue.length,
		activeCount: () => active,
	};
}

export type AdminPrefetcher = ReturnType<typeof createAdminPrefetcher>;

/** 应用级单例：`ui/routes.tsx` 注册 loader，`Sidebar` 负责触发。 */
export const adminPrefetcher = createAdminPrefetcher();

export function prefetchAdminRoute(id: string, trigger: PrefetchTrigger = 'speculative'): void {
	adminPrefetcher.prefetch(id, trigger);
}

export function resetAdminRoutePrefetch(id?: string): void {
	adminPrefetcher.reset(id);
}
