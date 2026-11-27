'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 根级鉴权壳（design D5/D6）。
 *
 * - 唯一的客户端会话拥有者：login / logout / expiry 全部交给 `admin-auth-coordinator`；
 * - `mode` 由服务端下发（运行期 `ADMIN_AUTH_MODE`）：`portal` 只显示 SSO，`password`/`both` 保留
 *   账密表单作为回滚与应急通道；
 * - `not_admin` / `sso_not_configured` 不自动跳转，避免与仍有效的门户会话形成重定向死循环；
 * - 失效时立即卸载敏感 UI，并清理密码等瞬态输入。
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import BrandExternalLinks from '@/components/layout/BrandExternalLinks';
import LocaleSwitcher from '@/components/layout/LocaleSwitcher';
import { BusinessTimezoneProvider } from '@/components/BusinessTimezoneProvider';
import { createAdminAuthCoordinator } from '@/lib/admin-auth-coordinator';
import { ADMIN_SESSION_EXPIRED_EVENT_NAME } from '@/lib/admin-session-events';
import { ADMIN_UI_PUBLIC_BASE } from '@/ui/public-path';
import { currentAdminNextPath } from '@/ui/sso-redirect';
import AdminShell from './AdminShell';
import { AuthSessionProvider } from './auth-session';

/** SSR 阶段不创建 BroadcastChannel；浏览器首批交集时使用真实通道。 */
const coordinator = createAdminAuthCoordinator({
	channel: typeof window === 'undefined' ? null : undefined,
});

const publicBase = ADMIN_UI_PUBLIC_BASE;

function currentPath(): string {
	if (typeof window === 'undefined') return '/';
	return currentAdminNextPath(
		{ pathname: window.location.pathname, search: window.location.search, hash: window.location.hash },
		publicBase,
	);
}

interface Props {
	children: ReactNode;
}

export default function AuthWrapper({ children }: Props) {
	const t = useTranslations('auth');
	const tBrand = useTranslations('brand');
	const tCommon = useTranslations('common');
	const snapshot = useSyncExternalStore(
		coordinator.subscribe,
		coordinator.getSnapshot,
		coordinator.getSnapshot,
	);
	// 会话代次或登录态变化时在渲染期重置表单：不保留上一个会话的账号名与明文密码，
	// 也避免用 effect 里 setState 触发级联渲染。
	const sessionKey = `${snapshot.generation}:${snapshot.authenticated}`;
	const [form, setForm] = useState({ sessionKey, username: '', password: '' });
	if (form.sessionKey !== sessionKey) {
		setForm({ sessionKey, username: '', password: '' });
	}
	const { username, password } = form;
	const [ready, setReady] = useState(false);
	const autoRedirected = useRef(false);

	const isBusy = snapshot.pending !== null;
	const passwordMode = snapshot.mode === 'password' || snapshot.mode === 'both';
	const ssoAvailable = snapshot.mode !== 'password';

	useEffect(() => {
		let cancelled = false;
		void coordinator.revalidate().finally(() => {
			if (!cancelled) setReady(true);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		const onSessionExpired = () => {
			void coordinator.handleExpiry();
		};
		window.addEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, onSessionExpired);
		return () => window.removeEventListener(ADMIN_SESSION_EXPIRED_EVENT_NAME, onSessionExpired);
	}, []);

	useEffect(() => {
		// 新开页/失焦恢复/BFCache 恢复后以 auth/check 重新建立状态，通知本身不作为鉴权真相。
		const revalidate = () => {
			void coordinator.revalidate();
		};
		const onVisible = () => {
			if (document.visibilityState === 'visible') revalidate();
		};
		document.addEventListener('visibilitychange', onVisible);
		window.addEventListener('pageshow', revalidate);
		return () => {
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener('pageshow', revalidate);
		};
	}, []);

	// 纯「未登录」才自动跳门户登录；`not_admin` / `sso_not_configured` 必须停在原地
	useEffect(() => {
		if (!ready || snapshot.authenticated || autoRedirected.current) return;
		if (snapshot.mode === 'password') return;
		if (snapshot.reason || !snapshot.loginUrl) return;
		autoRedirected.current = true;
		coordinator.startSsoLogin(currentPath());
	}, [ready, snapshot.authenticated, snapshot.mode, snapshot.reason, snapshot.loginUrl]);

	const handleLogin = useCallback(
		async (event: React.FormEvent) => {
			event.preventDefault();
			if (isBusy) return;
			const submittedPassword = password;
			// 立即清空密码：pending 期间不保存，也不排队重放。
			setForm((prev) => ({ ...prev, password: '' }));
			try {
				await coordinator.login(username, submittedPassword);
			} catch {
				// 协调器内部已兜底；这里只保证表单不会卡在未处理的拒绝上。
			}
		},
		[isBusy, password, username],
	);

	const handleSsoLogin = useCallback(() => {
		coordinator.startSsoLogin(currentPath());
	}, []);

	const handleSwitchAccount = useCallback(async () => {
		// 先清门户会话，再走 SSO；否则会带着同一个账号立刻被判定为 not_admin
		await coordinator.logout();
		coordinator.startSsoLogin(currentPath());
	}, []);

	const sessionValue = { snapshot, login: coordinator.login, logout: coordinator.logout };

	if (!ready && !snapshot.authenticated) {
		return (
			<div className="flex h-dvh items-center justify-center bg-gray-50">
				<div className="text-gray-600">{tCommon('loading')}</div>
			</div>
		);
	}

	if (!snapshot.authenticated) {
		const reason = snapshot.reason;
		return (
			<AuthSessionProvider value={sessionValue}>
				<div className="flex h-dvh items-start justify-center overflow-y-auto bg-gray-50 p-4">
					<div className="my-auto w-full max-w-md rounded-lg bg-white p-5 shadow-md sm:p-8">
						<div className="mb-6 flex items-start justify-between gap-3">
							<div className="min-w-0">
								<h1 className="text-2xl font-bold text-gray-800">{tBrand('loginHeading')}</h1>
								<p className="mt-1 text-xs text-gray-500">{tBrand('operatorConsole')}</p>
							</div>
							<LocaleSwitcher variant="login" />
						</div>

						{reason === 'sso_not_configured' ? (
							<div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
								<p className="font-medium">{t('ssoNotConfigured')}</p>
								<p className="mt-1 text-amber-700">{t('ssoNotConfiguredHint')}</p>
							</div>
						) : null}

						{reason === 'not_admin' ? (
							<div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
								<p className="font-medium">{t('notAdmin')}</p>
								<p className="mt-1 text-amber-700">{t('notAdminHint')}</p>
								{snapshot.username ? (
									<p className="mt-1 text-xs text-amber-700">{snapshot.username}</p>
								) : null}
								<div className="mt-3 flex flex-wrap gap-2">
									<button
										type="button"
										onClick={handleSsoLogin}
										disabled={!snapshot.loginUrl}
										className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
									>
										{t('relogin')}
									</button>
									<button
										type="button"
										onClick={() => void handleSwitchAccount()}
										className="rounded-md bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200"
									>
										{t('switchAccount')}
									</button>
								</div>
							</div>
						) : null}

						{reason === 'not_admin' || reason === 'sso_not_configured' ? null : (
							<>
								{ssoAvailable ? (
									<button
										type="button"
										onClick={handleSsoLogin}
										disabled={isBusy || !snapshot.loginUrl}
										className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
									>
										{isBusy ? t('loggingIn') : t('ssoLogin')}
									</button>
								) : null}
								{ssoAvailable ? (
									<p className="mt-2 text-center text-[11.5px] text-gray-500">{t('ssoHint')}</p>
								) : null}
							</>
						)}

						{passwordMode ? (
							<form onSubmit={handleLogin} className="mt-6 border-t border-gray-100 pt-4">
								<div className="mb-4">
									<label htmlFor="username" className="mb-2 block text-sm font-medium text-gray-700">
										{t('username')}
									</label>
									<input
										id="username"
										type="text"
										value={username}
										onChange={(e) => setForm((prev) => ({ ...prev, username: e.target.value }))}
										className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
										required
										autoComplete="username"
										disabled={isBusy}
									/>
								</div>
								<div className="mb-6">
									<label htmlFor="password" className="mb-2 block text-sm font-medium text-gray-700">
										{t('password')}
									</label>
									<input
										id="password"
										type="password"
										value={password}
										onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
										className="w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
										required
										autoComplete="current-password"
										disabled={isBusy}
									/>
								</div>
								<button
									type="submit"
									disabled={isBusy}
									className="w-full rounded-md bg-gray-800 px-4 py-2 text-white hover:bg-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
								>
									{isBusy ? t('loggingIn') : t('login')}
								</button>
							</form>
						) : null}

						{snapshot.error ? (
							<div
								role="alert"
								className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-600"
							>
								<p>{snapshot.error}</p>
								{snapshot.lastAction === 'logout' || snapshot.lastAction === 'expiry' ? (
									<button
										type="button"
										onClick={() => void coordinator.logout()}
										disabled={isBusy}
										className="mt-2 text-xs font-medium text-red-700 underline disabled:opacity-50"
									>
										{t('logout')}
									</button>
								) : null}
							</div>
						) : null}

						<div className="mt-6 border-t border-gray-100 pt-4">
							<BrandExternalLinks variant="login" />
						</div>
					</div>
				</div>
			</AuthSessionProvider>
		);
	}

	return (
		<AuthSessionProvider value={sessionValue}>
			<BusinessTimezoneProvider>
				<AdminShell>{children}</AdminShell>
			</BusinessTimezoneProvider>
		</AuthSessionProvider>
	);
}
