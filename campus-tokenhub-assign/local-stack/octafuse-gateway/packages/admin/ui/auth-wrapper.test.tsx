/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 根级鉴权壳的登录形态（design D5/D6）。
 *
 * 约束：
 * - `portal` 模式不渲染账密输入框，只给 SSO 入口；
 * - `password`/`both` 模式保留账密表单（回滚通道），失败提示但不保留已提交密码；
 * - `not_admin` / `sso_not_configured` 停在原地，不自动跳转；
 * - 纯未登录 + 有 loginUrl 时自动跳一次门户登录。
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/messages/en.json';
import AuthWrapper from '@/components/layout/AuthWrapper';

// 模拟带 /tokenhub/admin 前缀的生产构建：退出后重新登录必须把前缀从 next 里剥掉。
vi.mock('@/ui/public-path', () => ({ ADMIN_UI_PUBLIC_BASE: '/tokenhub/admin' }));

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function renderApp() {
	return render(
		<NextIntlClientProvider locale="en" messages={en}>
			<MemoryRouter initialEntries={['/dashboard']}>
				<AuthWrapper>
					<div>sensitive-console</div>
				</AuthWrapper>
			</MemoryRouter>
		</NextIntlClientProvider>,
	);
}

function submitLogin() {
	const form = document.querySelector('form');
	if (!form) throw new Error('login form is not rendered');
	fireEvent.submit(form);
}

let checkResponse: () => Promise<Response>;
let loginResponse: () => Promise<Response>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
	checkResponse = async () => json({ authenticated: false, mode: 'portal' });
	loginResponse = async () => json({ success: false, message: 'Invalid credentials' });
	assign = vi.fn();
	Object.defineProperty(window, 'location', {
		configurable: true,
		value: {
			href: 'http://localhost/tokenhub/admin/dashboard',
			origin: 'http://localhost',
			pathname: '/tokenhub/admin/dashboard',
			search: '?tab=keys',
			hash: '#section',
			assign,
			replace: vi.fn(),
			reload: vi.fn(),
		},
	});
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			if (url.includes('/api/auth/check')) return checkResponse();
			if (url.includes('/api/auth/login')) return loginResponse();
			if (url.includes('/api/auth/logout')) return json({ success: true });
			return json({ success: true, data: [] });
		}),
	);
	// jsdom 没有 matchMedia；AdminShell 只在登录成功后挂载。
	vi.stubGlobal('matchMedia', () => ({
		matches: false,
		addEventListener: () => {},
		removeEventListener: () => {},
	}));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('AuthWrapper portal 模式', () => {
	it('只给 SSO 入口，不渲染账密输入框', async () => {
		renderApp();

		expect(await screen.findByRole('button', { name: en.auth.ssoLogin })).toBeInTheDocument();
		expect(screen.queryByLabelText(en.auth.username)).not.toBeInTheDocument();
		expect(screen.queryByLabelText(en.auth.password)).not.toBeInTheDocument();
		expect(screen.queryByText('sensitive-console')).not.toBeInTheDocument();
	});

	it('拿到 loginUrl 时自动跳转一次，next 保留 query 与片段', async () => {
		checkResponse = async () =>
			json({ authenticated: false, mode: 'portal', loginUrl: 'https://api.test/tokenhub/portal/login' });
		renderApp();

		await waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
		const target = new URL(assign.mock.calls[0]![0] as string);
		expect(target.searchParams.get('dest')).toBe('admin');
		// 前缀只保留一份，query 与 hash 完整保留（退出后重新登录的回归）
		expect(target.searchParams.get('next')).toBe('/dashboard?tab=keys#section');
	});
});

describe('AuthWrapper 异常状态', () => {
	it('not_admin 停在原地，给出「重新登录」与「退出当前账号」', async () => {
		checkResponse = async () =>
			json({
				authenticated: false,
				mode: 'portal',
				reason: 'not_admin',
				loginUrl: 'https://api.test/tokenhub/portal/login',
			});
		renderApp();

		expect(await screen.findByText(en.auth.notAdmin)).toBeInTheDocument();
		expect(screen.getByRole('button', { name: en.auth.relogin })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: en.auth.switchAccount })).toBeInTheDocument();
		expect(assign).not.toHaveBeenCalled();
	});

	it('sso_not_configured 显示配置错误，不跳转也不给无效的登录按钮', async () => {
		checkResponse = async () =>
			json({ authenticated: false, mode: 'portal', reason: 'sso_not_configured' });
		renderApp();

		expect(await screen.findByText(en.auth.ssoNotConfigured)).toBeInTheDocument();
		expect(assign).not.toHaveBeenCalled();
		expect(screen.queryByRole('button', { name: en.auth.ssoLogin })).not.toBeInTheDocument();
	});
});

describe('AuthWrapper password 模式（回滚通道）', () => {
	beforeEach(() => {
		checkResponse = async () => json({ authenticated: false, mode: 'password' });
	});

	it('保留账密表单，失败提示且清空密码', async () => {
		renderApp();
		fireEvent.change(await screen.findByLabelText(en.auth.username), { target: { value: 'admin' } });
		fireEvent.change(screen.getByLabelText(en.auth.password), { target: { value: 'wrong-secret' } });
		submitLogin();

		expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
		expect((screen.getByLabelText(en.auth.password) as HTMLInputElement).value).toBe('');
		expect(screen.queryByText('sensitive-console')).not.toBeInTheDocument();
		expect(assign).not.toHaveBeenCalled();
	});

	it('会话变化时丢弃半输入的密码', async () => {
		renderApp();
		const password = (await screen.findByLabelText(en.auth.password)) as HTMLInputElement;
		fireEvent.change(password, { target: { value: 'typed-but-not-submitted' } });
		expect(password.value).toBe('typed-but-not-submitted');

		await act(async () => {
			window.dispatchEvent(new CustomEvent('octafuse-admin-session-expired'));
		});

		await waitFor(() => {
			expect((screen.getByLabelText(en.auth.password) as HTMLInputElement).value).toBe('');
		});
	});
});
