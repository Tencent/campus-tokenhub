/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 路由预取与版本核对（2.3.1 红测基线）。
 *
 * 约束（design D5 / spec「route resource prefetch does not execute business operations」）：
 * - 只有 hover/focus 的明确意图触发，菜单可见不批量预取；
 * - 推测并发最多 2，同一 route 只加载一次，点击优先；
 * - data-saving 时关闭推测，点击不受影响；
 * - 失败可清理后重试，不无限重试；
 * - 版本核对只跑一次且有界，网络/解析失败一律 `unknown`。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdminPrefetcher } from './prefetch';
import { adminUiVersionPath, checkAdminUiVersion } from '@/lib/admin-ui-version';

function deferredLoader() {
	let resolve!: () => void;
	let reject!: (error?: unknown) => void;
	const calls = { count: 0 };
	const loader = () => {
		calls.count += 1;
		return new Promise<{ default: () => null }>((res, rej) => {
			resolve = () => res({ default: () => null });
			reject = rej;
		});
	};
	return { loader, calls, resolve: () => resolve(), reject: (error?: unknown) => reject(error) };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createAdminPrefetcher', () => {
	it('deduplicates concurrent prefetch of the same route', async () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2 });
		const item = deferredLoader();
		prefetcher.register({ models: item.loader });

		prefetcher.prefetch('models');
		prefetcher.prefetch('models');
		prefetcher.prefetch('models', 'click');

		expect(item.calls.count).toBe(1);
		item.resolve();
		await flush();
		expect(prefetcher.isLoaded('models')).toBe(true);
	});

	it('caps speculative concurrency at two', async () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2 });
		const items = {
			a: deferredLoader(),
			b: deferredLoader(),
			c: deferredLoader(),
			d: deferredLoader(),
		};
		prefetcher.register({
			a: items.a.loader,
			b: items.b.loader,
			c: items.c.loader,
			d: items.d.loader,
		});

		for (const id of ['a', 'b', 'c', 'd']) prefetcher.prefetch(id);
		expect(prefetcher.activeCount()).toBe(2);
		expect(prefetcher.pendingCount()).toBe(2);

		items.a.resolve();
		await flush();
		// 释放一个槽位后队列前进一个，仍然不超过 2。
		expect(prefetcher.activeCount()).toBe(2);
		expect(items.c.calls.count).toBe(1);
		expect(items.d.calls.count).toBe(0);
	});

	it('lets a click jump ahead of queued speculative loads', () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2 });
		const items = {
			a: deferredLoader(),
			b: deferredLoader(),
			c: deferredLoader(),
			clicked: deferredLoader(),
		};
		prefetcher.register({
			a: items.a.loader,
			b: items.b.loader,
			c: items.c.loader,
			clicked: items.clicked.loader,
		});

		prefetcher.prefetch('a');
		prefetcher.prefetch('b');
		prefetcher.prefetch('c');
		expect(items.clicked.calls.count).toBe(0);

		prefetcher.prefetch('clicked', 'click');
		expect(items.clicked.calls.count).toBe(1);
	});

	it('skips speculative prefetch when data saving is on but still loads on click', () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2, isDataSaving: () => true });
		const item = deferredLoader();
		prefetcher.register({ models: item.loader });

		prefetcher.prefetch('models');
		expect(item.calls.count).toBe(0);

		prefetcher.prefetch('models', 'click');
		expect(item.calls.count).toBe(1);
	});

	it('clears a failed prefetch record when the user clicks the same route', async () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2 });
		const item = deferredLoader();
		prefetcher.register({ models: item.loader });

		prefetcher.prefetch('models');
		item.reject(new Error('chunk failed'));
		await flush();
		expect(prefetcher.isFailed('models')).toBe(true);

		prefetcher.prefetch('models', 'click');
		expect(prefetcher.isFailed('models')).toBe(false);
		expect(item.calls.count).toBe(2);
	});

	it('records failures without caching a rejected promise, and retries after reset', async () => {
		const prefetcher = createAdminPrefetcher({ maxConcurrent: 2 });
		const item = deferredLoader();
		prefetcher.register({ models: item.loader });

		prefetcher.prefetch('models');
		item.reject(new Error('chunk failed'));
		await flush();

		expect(prefetcher.isFailed('models')).toBe(true);
		prefetcher.prefetch('models');
		expect(item.calls.count).toBe(1);

		prefetcher.reset('models');
		expect(prefetcher.isFailed('models')).toBe(false);
		prefetcher.prefetch('models');
		expect(item.calls.count).toBe(2);
	});
});

describe('checkAdminUiVersion', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		});

	it('builds the version path under the public prefix', () => {
		expect(adminUiVersionPath('')).toBe('/ui-version.json');
		expect(adminUiVersionPath('/tokenhub/admin')).toBe('/tokenhub/admin/ui-version.json');
	});

	it('reports same / changed / unknown', async () => {
		const same = vi.fn(async () => json({ buildId: 'b1' }));
		expect(await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: same })).toMatchObject({
			status: 'same',
		});

		const changed = vi.fn(async () => json({ buildId: 'b2' }));
		expect(await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: changed })).toMatchObject({
			status: 'changed',
			remoteBuildId: 'b2',
		});

		const missingField = vi.fn(async () => json({}));
		expect(
			await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: missingField }),
		).toMatchObject({ status: 'unknown' });
	});

	it('treats non-200, parse errors and network failures as unknown', async () => {
		const notFound = vi.fn(async () => json({ buildId: 'b1' }, 404));
		expect(await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: notFound })).toMatchObject({
			status: 'unknown',
		});

		const badJson = vi.fn(
			async () => new Response('not-json', { status: 200, headers: { 'content-type': 'text/html' } }),
		);
		expect(await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: badJson })).toMatchObject({
			status: 'unknown',
		});

		const networkError = vi.fn(async () => {
			throw new Error('offline');
		});
		expect(
			await checkAdminUiVersion({ currentBuildId: 'b1', fetchImpl: networkError }),
		).toMatchObject({ status: 'unknown' });
	});

	it('does not use cache and keeps the request bounded', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const impl: typeof fetch = vi.fn(async (input, init) => {
			calls.push({ url: String(input), init });
			return json({ buildId: 'b1' });
		});
		await checkAdminUiVersion({ currentBuildId: 'b1', base: '/tokenhub/admin', fetchImpl: impl });
		expect(calls[0]?.url).toBe('/tokenhub/admin/ui-version.json');
		expect(calls[0]?.init?.cache).toBe('no-store');
		expect(calls[0]?.init?.signal).toBeTruthy();
	});
});
