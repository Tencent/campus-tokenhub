/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 语言 / 时区 / 标题 Provider（2.3.1 红测基线）。
 *
 * 约束（spec「locale, titles and page operations are not lost」）：
 * - SPA 没有服务端 Provider，必须在客户端显式装配 locale、messages 与 timeZone；
 * - 页面标题随路由与语言变化，不依赖 Next 的 `generateMetadata`；
 * - 缺少 Provider 时不得静默渲染成 key。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { describe, expect, it } from 'vitest';
import zh from '@/messages/zh.json';
import { AdminUiProviders } from './App';
import { useRouter } from './navigation';

function Probe() {
	const locale = useLocale();
	const timeZone = useTimeZone();
	const tSidebar = useTranslations('sidebar');
	const tMeta = useTranslations('metadata');
	return (
		<div>
			<span data-testid="locale">{locale}</span>
			<span data-testid="timezone">{timeZone}</span>
			<span data-testid="nav-models">{tSidebar('nav.models')}</span>
			<span data-testid="app-title">{tMeta('title')}</span>
		</div>
	);
}

function renderAt(entry: string, locale: 'zh' | 'en' = 'zh') {
	return render(
		<MemoryRouter initialEntries={[entry]}>
			<AdminUiProviders locale={locale}>
				<Probe />
			</AdminUiProviders>
		</MemoryRouter>,
	);
}

describe('AdminUiProviders', () => {
	it('supplies locale, messages and a fixed time zone', () => {
		renderAt('/dashboard', 'zh');
		expect(screen.getByTestId('locale')).toHaveTextContent('zh');
		expect(screen.getByTestId('timezone')).toHaveTextContent('UTC');
		expect(screen.getByTestId('nav-models')).toHaveTextContent(zh.sidebar.nav.models);
		expect(screen.getByTestId('app-title')).toHaveTextContent(zh.metadata.title);
	});

	it('can switch to another locale bundle without missing keys', () => {
		renderAt('/dashboard', 'en');
		expect(screen.getByTestId('locale')).toHaveTextContent('en');
		expect(screen.getByTestId('nav-models')).not.toHaveTextContent('nav.models');
	});

	it('writes a page-specific document title from the current route', async () => {
		renderAt('/gateway/models', 'zh');
		await waitFor(() => {
			expect(document.title).toContain(zh.sidebar.nav.models);
		});
		expect(document.title).toContain('Octafuse');
	});

	it('updates the title after a client-side route change without a document reload', async () => {
		function TitleProbe() {
			const router = useRouter();
			return (
				<>
					<button type="button" onClick={() => router.push('/gateway/models')}>
						go-models
					</button>
					<Routes>
						<Route path="/dashboard" element={<span>dashboard-page</span>} />
						<Route path="/gateway/models" element={<span>models-page</span>} />
					</Routes>
				</>
			);
		}

		render(
			<MemoryRouter initialEntries={['/dashboard']}>
				<AdminUiProviders locale="zh">
					<TitleProbe />
				</AdminUiProviders>
			</MemoryRouter>,
		);

		await waitFor(() => expect(document.title).toContain(zh.sidebar.nav.dashboard));
		fireEvent.click(screen.getByRole('button', { name: 'go-models' }));
		await screen.findByText('models-page');
		await waitFor(() => expect(document.title).toContain(zh.sidebar.nav.models));
		expect(document.title).toContain('Octafuse');
	});
});
