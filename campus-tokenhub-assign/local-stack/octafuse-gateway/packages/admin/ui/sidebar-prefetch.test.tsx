/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 菜单意图预取（2.3.1）。
 *
 * 约束（spec「route resource prefetch does not execute business operations」）：
 * - 菜单可见本身不批量预取；
 * - 仅 hover / keyboard focus 触发推测预取；
 * - 点击同时也以 click 优先级触发，与预取共用去重；
 * - 预取只由 route ID 驱动，不提前请求业务 API。
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import zh from '@/messages/zh.json';
import Sidebar from '@/components/layout/Sidebar';
import { AdminUiProviders } from './App';
import { AuthSessionProvider } from '@/components/layout/auth-session';

const AUTH_SESSION_STUB = {
	snapshot: {
		generation: 0,
		authenticated: true,
		pending: null,
		error: null,
		lastAction: null,
		coordination: 'web-locks' as const,
		mode: 'portal' as const,
		reason: null,
		loginUrl: null,
		username: null,
	},
	login: async () => 'success' as const,
	logout: async () => 'success' as const,
};
import type { PrefetchTrigger } from './prefetch';

function renderSidebar() {
	const calls: Array<{ id: string; trigger: PrefetchTrigger }> = [];
	render(
		<MemoryRouter initialEntries={['/dashboard']}>
			<AdminUiProviders locale="zh">
				<AuthSessionProvider value={AUTH_SESSION_STUB}>
					<Sidebar prefetchRoute={(id, trigger) => calls.push({ id, trigger })} />
				</AuthSessionProvider>
			</AdminUiProviders>
		</MemoryRouter>,
	);
	return calls;
}

const navLink = (name: string) => screen.getByRole('link', { name });

describe('Sidebar route prefetch', () => {
	it('does not prefetch anything just because the menu is visible', () => {
		const calls = renderSidebar();
		expect(calls).toHaveLength(0);
	});

	it('prefetches on hover and keyboard focus only', () => {
		const calls = renderSidebar();

		fireEvent.mouseEnter(navLink(zh.sidebar.nav.models));
		expect(calls).toEqual([{ id: 'models', trigger: 'speculative' }]);

		fireEvent.focus(navLink(zh.sidebar.nav.providers));
		expect(calls).toEqual([
			{ id: 'models', trigger: 'speculative' },
			{ id: 'providers', trigger: 'speculative' },
		]);
	});

	it('marks a click as a click-priority prefetch without losing the navigation handler', () => {
		const calls: Array<{ id: string; trigger: PrefetchTrigger }> = [];
		let navigated = 0;
		render(
			<MemoryRouter initialEntries={['/dashboard']}>
				<AdminUiProviders locale="zh">
					<AuthSessionProvider value={AUTH_SESSION_STUB}>
						<Sidebar
							onNavigate={() => {
								navigated += 1;
							}}
							prefetchRoute={(id, trigger) => calls.push({ id, trigger })}
						/>
					</AuthSessionProvider>
				</AdminUiProviders>
			</MemoryRouter>,
		);

		fireEvent.click(navLink(zh.sidebar.nav.apiKeys));
		expect(calls).toEqual([{ id: 'keys', trigger: 'click' }]);
		expect(navigated).toBe(1);
	});

	it('maps every sidebar menu entry to a known route id', () => {
		const calls = renderSidebar();
		const names = Object.values(zh.sidebar.nav);
		expect(names.length).toBeGreaterThan(0);
		for (const name of names) {
			const link = navLink(name);
			fireEvent.mouseEnter(link);
		}
		// 全部菜单项都必须能映射到 route ID，不允许出现 undefined。
		expect(calls.every((call) => typeof call.id === 'string' && call.id.length > 0)).toBe(true);
		expect(new Set(calls.map((call) => call.id)).size).toBe(names.length);
	});
});
