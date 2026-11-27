/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 SPA 根组件。
 *
 * 1.2 首组显式装配页面必需的最小 Provider：
 * - locale / messages / timeZone：读取现有 `NEXT_LOCALE` cookie，复用
 *   `messages/*.json`，时区与 Next `lib/i18n.ts` 保持一致（UTC）；
 * - FeedbackProvider：现有 toast/confirm；
 * - DocumentTitle：复用现有标题逻辑；
 * - AuthWrapper：唯一客户端会话入口，继续请求根 `/api/auth/*`。
 *
 * 完整语言切换、预取与多标签会话协调分别在 2.3 / 3.2 扩展。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { BrowserRouter } from 'react-router-dom';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/messages/en.json';
import ja from '@/messages/ja.json';
import ko from '@/messages/ko.json';
import zh from '@/messages/zh.json';
import { FeedbackProvider } from '@/components/feedback';
import AuthWrapper from '@/components/layout/AuthWrapper';
import DocumentTitle from '@/components/layout/DocumentTitle';
import { LOCALE_COOKIE, resolveLocale, type Locale } from '@/lib/locale';
import { ADMIN_UI_REFRESH_EVENT } from './navigation';
import { ADMIN_UI_ROUTER_BASENAME } from './public-path';
import { AdminAppBoundary } from './route-load-boundary';
import { AdminUiRoutes } from './routes';

const MESSAGES: Record<Locale, typeof en> = { en, zh, ja, ko };

function readLocaleCookie(): Locale {
	if (typeof document === 'undefined') return resolveLocale(undefined);
	const entry = document.cookie
		.split(';')
		.map((item) => item.trim())
		.find((item) => item.startsWith(`${LOCALE_COOKIE}=`));
	return resolveLocale(entry?.slice(LOCALE_COOKIE.length + 1));
}

/** 语言 / 文案 / 时区 / 标题 Provider（不含会话，便于单独测试）。 */
export function AdminUiProviders({ locale, children }: { locale: Locale; children: ReactNode }) {
	return (
		<NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
			<FeedbackProvider>
				<DocumentTitle />
				{children}
			</FeedbackProvider>
		</NextIntlClientProvider>
	);
}

function Providers({ locale, children }: { locale: Locale; children: ReactNode }) {
	return (
		<AdminUiProviders locale={locale}>
			<AuthWrapper>{children}</AuthWrapper>
		</AdminUiProviders>
	);
}

export default function App() {
	const [locale, setLocale] = useState<Locale>(() => readLocaleCookie());

	useEffect(() => {
		// `router.refresh()`（LocaleSwitcher）与窗口重新获得焦点时重读 locale cookie。
		const sync = () => {
			const next = readLocaleCookie();
			setLocale(next);
			document.documentElement.lang = next;
		};
		window.addEventListener(ADMIN_UI_REFRESH_EVENT, sync);
		window.addEventListener('focus', sync);
		return () => {
			window.removeEventListener(ADMIN_UI_REFRESH_EVENT, sync);
			window.removeEventListener('focus', sync);
		};
	}, []);

	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);

	return (
		<BrowserRouter basename={ADMIN_UI_ROUTER_BASENAME}>
			<AdminAppBoundary>
				<Providers locale={locale}>
					<AdminUiRoutes />
				</Providers>
			</AdminAppBoundary>
		</BrowserRouter>
	);
}
