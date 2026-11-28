/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 浏览器侧路由（1.2.1 红测基线）。
 *
 * 约束（design D3）：
 * - 浏览器路由必须由同一份纯数据 `lib/admin-ui-route-manifest.ts` 驱动；
 * - dashboard 与动态 users/:id 都能直接深链接进入（刷新场景）；
 * - 动态详情链接点击是客户端软导航，不改 document；
 * - 浏览器 history 前进/后退恢复路由；
 * - API/资源不是 UI 路由，Node 不会用 HTML 覆盖它们。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessTimezoneProvider } from '@/components/BusinessTimezoneProvider';
import { FeedbackProvider } from '@/components/feedback';
import en from '@/messages/en.json';
import { ADMIN_UI_ROUTES, matchAdminUiRoute } from '@/lib/admin-ui-route-manifest';
import { ADMIN_NAV_ROUTES } from '@/lib/admin-nav';
import Link from './link';
import { ADMIN_UI_REFRESH_EVENT, useRouter, useSearchParams } from './navigation';
import { AdminUiRoutes } from './routes';
import { ADMIN_UI_ROUTE_MODULES } from './route-modules';

const USER_ID = 'u-1';

const USER_DETAIL = {
	id: USER_ID,
	email: 'u-1@example.com',
	status: 'active',
	budget_max: null,
	budget_base: 0,
	budget_spent: 0,
	budget_period: 'none',
	budget_reset_at: null,
	wallet_granted: 0,
	wallet_spent: 0,
	metadata: null,
	charged_cost_factors: null,
	external_system: null,
	external_user_id: null,
	rate_limit: null,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
};

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function installFetchMock() {
	const mock = vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		if (url.includes(`/api/admin/users/${USER_ID}/keys`)) return json({ success: true, data: [] });
		if (url.includes(`/api/admin/users/${USER_ID}/logs`)) return json({ success: true, data: [] });
		if (url.includes(`/api/admin/users/${USER_ID}/oauth-access-tokens`)) {
			return json({ success: true, data: [] });
		}
		if (url.includes(`/api/admin/users/${USER_ID}`)) return json({ success: true, data: USER_DETAIL });
		if (url.includes('/api/admin/budget-audit-logs')) return json({ success: true, data: [] });
		if (url.includes('/api/admin/models')) return json({ success: true, data: [] });
		if (url.includes('/api/admin/routes')) return json({ success: true, data: [] });
		if (url.includes('/api/admin/stats')) return json({ success: true, data: {} });
		if (url.includes('/api/admin/config')) return json({ success: true, data: [] });
		if (url.includes('/api/admin/business-timezone')) return json({ success: true, data: {} });
		if (url.includes('/api/admin/maintenance')) {
			return json({ success: true, data: { config: { enabled: false } } });
		}
		return json({ success: true, data: [] });
	});
	vi.stubGlobal('fetch', mock);
	return mock;
}

function NavProbe() {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<div>
			<span data-testid="location">{location.pathname}</span>
			<Link href="/gateway/users/u-1">open user detail</Link>
			<Link href="/dashboard">open dashboard</Link>
			<Link href="/gateway/models">open models</Link>
			<button type="button" onClick={() => navigate(-1)}>
				history back
			</button>
		</div>
	);
}

function renderAt(entry: string) {
	return render(
		<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
			<FeedbackProvider>
				<BusinessTimezoneProvider>
					<MemoryRouter initialEntries={[entry]}>
						<NavProbe />
						<AdminUiRoutes />
					</MemoryRouter>
				</BusinessTimezoneProvider>
			</FeedbackProvider>
		</NextIntlClientProvider>,
	);
}

describe('admin UI route manifest drives the browser router', () => {
	it('binds every manifest page route to a browser component', () => {
		for (const route of ADMIN_UI_ROUTES) {
			if (route.kind !== 'page') continue;
			expect(ADMIN_UI_ROUTE_MODULES[route.id], `missing binding for ${route.id}`).toBeTypeOf('function');
		}
	});

	it('keeps API and asset paths out of the UI route table', () => {
		expect(matchAdminUiRoute('/api/admin/stats')).toBeNull();
		expect(matchAdminUiRoute('/assets/app-abc123.js')).toBeNull();
	});
});

describe('full route manifest', () => {
	it('covers every sidebar menu entry', () => {
		const pagePaths = ADMIN_UI_ROUTES.filter((route) => route.kind === 'page').map(
			(route) => route.pattern,
		);
		for (const item of ADMIN_NAV_ROUTES) {
			expect(pagePaths, `menu href ${item.href} missing from manifest`).toContain(item.href);
		}
	});

	it('binds every manifest page route to a browser component', () => {
		for (const route of ADMIN_UI_ROUTES) {
			if (route.kind === 'page') {
				expect(ADMIN_UI_ROUTE_MODULES[route.id], `missing binding for ${route.id}`).toBeTypeOf('function');
			} else {
				expect(route.redirectTo, `missing redirect target for ${route.id}`).toBeTruthy();
			}
		}
	});

	it('keeps the root and legacy OAuth redirects', () => {
		expect(matchAdminUiRoute('/')?.route.redirectTo).toBe('/dashboard');
		expect(matchAdminUiRoute('/gateway/oauth-access-tokens')?.route.redirectTo).toBe(
			'/gateway/mcp#oauth-access-tokens',
		);
	});

	it('matches the dynamic user detail but not deeper segments', () => {
		expect(matchAdminUiRoute('/gateway/users/u-1')?.route.id).toBe('user-detail');
		expect(matchAdminUiRoute('/gateway/users/u-1/keys')).toBeNull();
	});

	it('covers all 23 page sources from the baseline manifest', () => {
		// 21 个内容页 + 根重定向 + 旧 OAuth 重定向。
		const pageRoutes = ADMIN_UI_ROUTES.filter((route) => route.kind === 'page');
		expect(pageRoutes).toHaveLength(22);
		expect(ADMIN_UI_ROUTES).toHaveLength(24);
	});
});

describe('AdminUiRoutes', () => {
	beforeEach(() => {
		installFetchMock();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('renders the dashboard on a deep link (refresh)', async () => {
		renderAt('/dashboard');
		await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard'));
		expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
	});

	it('renders a dynamic user detail on a deep link (refresh)', async () => {
		renderAt(`/gateway/users/${USER_ID}`);
		expect(await screen.findByText('u-1@example.com', {}, { timeout: 5000 })).toBeInTheDocument();
		expect(screen.getByTestId('location')).toHaveTextContent(`/gateway/users/${USER_ID}`);
	});

	it('soft-navigates dashboard -> dynamic detail without replacing the document', async () => {
		renderAt('/dashboard');
		await screen.findByRole('heading', { name: /dashboard/i });

		const marker = document.createElement('div');
		marker.id = 'soft-nav-marker';
		document.body.appendChild(marker);

		fireEvent.click(screen.getByRole('link', { name: 'open user detail' }));

		expect(await screen.findByText('u-1@example.com', {}, { timeout: 5000 })).toBeInTheDocument();
		expect(screen.getByTestId('location')).toHaveTextContent(`/gateway/users/${USER_ID}`);
		expect(document.getElementById('soft-nav-marker')).not.toBeNull();
		marker.remove();
	});

	it('restores the previous route with browser history', async () => {
		renderAt('/dashboard');
		await screen.findByRole('heading', { name: /dashboard/i });

		fireEvent.click(screen.getByRole('link', { name: 'open user detail' }));
		expect(await screen.findByText('u-1@example.com', {}, { timeout: 5000 })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('link', { name: 'open dashboard' }));
		expect(await screen.findByRole('heading', { name: /dashboard/i })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'history back' }));
		expect(await screen.findByText('u-1@example.com', {}, { timeout: 5000 })).toBeInTheDocument();
		expect(screen.getByTestId('location')).toHaveTextContent(`/gateway/users/${USER_ID}`);
	});

	it('shows an explicit not-found state for an unknown UI path', async () => {
		renderAt('/gateway/not-a-real-page');
		expect(await screen.findByRole('heading', { name: /not found/i })).toBeInTheDocument();
	});
});

describe('next/navigation adapter', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('keeps non-manifest internal paths as full-page anchors instead of swallowing them', () => {
		function NonManifestLink() {
			return <Link href="/gateway/not-a-route">open non-manifest</Link>;
		}
		render(
			<MemoryRouter initialEntries={['/dashboard']}>
				<NavProbe />
				<NonManifestLink />
			</MemoryRouter>,
		);
		const link = screen.getByRole('link', { name: 'open non-manifest' });
		// 非清单路径不能交给 Router（会落到 UnknownRoute），必须整页请求；
		// RouterLink 会带 `data-discover`，普通 <a> 没有。
		expect(link.tagName).toBe('A');
		expect(link).toHaveAttribute('href', '/gateway/not-a-route');
		expect(link).not.toHaveAttribute('data-discover');
	});

	it('returns a single search params object and emits a refresh signal', () => {
		function Probe() {
			const params = useSearchParams();
			const router = useRouter();
			return (
				<>
					<span data-testid="tab">{params.get('tab') ?? ''}</span>
					<button type="button" onClick={() => router.refresh()}>
						refresh
					</button>
				</>
			);
		}

		const listener = vi.fn();
		window.addEventListener(ADMIN_UI_REFRESH_EVENT, listener);
		render(
			<MemoryRouter initialEntries={['/dashboard?tab=keys']}>
				<Probe />
			</MemoryRouter>,
		);

		expect(screen.getByTestId('tab')).toHaveTextContent('keys');
		fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener(ADMIN_UI_REFRESH_EVENT, listener);
	});
});
