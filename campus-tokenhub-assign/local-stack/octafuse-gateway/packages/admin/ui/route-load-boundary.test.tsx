/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 路由模块加载失败与版本提示（2.3.1）。
 *
 * 约束（design D5）：
 * - 资源失败时做一次有界 build 版本核对；
 * - 确认版本变化 → 显示更新提示，只有用户主动接受才刷新；
 * - 版本相同 / 无法核对 / metadata 缺失 → 只说明资源加载失败，不谎称新版本；
 * - 一次明确重试仍失败 → 保持可操作错误，并给出未保存风险提示；
 * - 拒绝刷新不刷新、不循环，重试与侧边栏导航仍可用。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteLoadBoundary, markModuleLoadFailure, RouteLoadError } from './route-load-boundary';
import { RoutePage } from './routes';
import type { AdminUiVersionResult, AdminUiVersionStatus } from '@/lib/admin-ui-version';

afterEach(() => {
	vi.unstubAllGlobals();
});

const versionResult = (status: AdminUiVersionStatus): AdminUiVersionResult => ({
	status,
	currentBuildId: 'build-1',
	...(status === 'changed' ? { remoteBuildId: 'build-2' } : {}),
});

function renderError(
	options: {
		attempt?: number;
		status?: AdminUiVersionStatus;
		checkVersion?: () => Promise<AdminUiVersionResult>;
	} = {},
) {
	const onRetry = vi.fn();
	const reload = vi.fn();
	const checkVersion =
		options.checkVersion ?? vi.fn(async () => versionResult(options.status ?? 'same'));
	render(
		<RouteLoadError
			routeId="models"
			attempt={options.attempt ?? 0}
			onRetry={onRetry}
			checkVersion={checkVersion}
			reload={reload}
		/>,
	);
	return { onRetry, reload, checkVersion };
}

describe('RouteLoadError version branches', () => {
	it('reports a confirmed build change and never reloads on its own', async () => {
		const { reload } = renderError({ status: 'changed' });
		expect(await screen.findByText(/new admin ui version/i)).toBeInTheDocument();
		expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
		expect(reload).not.toHaveBeenCalled();
	});

	it('does not claim a new version when the build id is unchanged', async () => {
		renderError({ status: 'same' });
		await screen.findByText(/failed to load/i);
		expect(screen.queryByText(/new admin ui version/i)).not.toBeInTheDocument();
		expect(screen.getByText(/same version/i)).toBeInTheDocument();
	});

	it('reports an unknown version when metadata is missing or unverifiable', async () => {
		const checkVersion = vi.fn(async () => versionResult('unknown'));
		renderError({ status: 'unknown', checkVersion });
		await screen.findByText(/failed to load/i);
		expect(screen.getByText(/could not be verified/i)).toBeInTheDocument();
		expect(screen.queryByText(/new admin ui version/i)).not.toBeInTheDocument();
		expect(checkVersion).toHaveBeenCalledTimes(1);
	});

	it('offers an explicit retry after the first failure', async () => {
		const { onRetry } = renderError({ status: 'same' });
		const retry = await screen.findByRole('button', { name: /try again/i });
		fireEvent.click(retry);
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('shows the unsaved-risk refresh prompt after an explicit retry failed, without auto reload', async () => {
		const { reload, checkVersion } = renderError({ attempt: 1 });
		expect(await screen.findByText(/still failed/i)).toBeInTheDocument();
		expect(screen.getByText(/unsaved/i)).toBeInTheDocument();
		expect(checkVersion).not.toHaveBeenCalled();
		expect(reload).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /refresh page/i }));
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('keeps the error operable when the user declines the refresh', async () => {
		const { reload } = renderError({ attempt: 1 });
		await screen.findByText(/still failed/i);
		fireEvent.click(screen.getByRole('button', { name: /not now/i }));
		expect(reload).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /refresh page/i })).not.toBeInTheDocument();
	});
});

describe('RouteLoadBoundary', () => {
	it('catches a failed route module and renders the retryable error panel', async () => {
		const onRetry = vi.fn();
		function Broken(): null {
			const error = new Error('Failed to fetch dynamically imported module');
			markModuleLoadFailure(error);
			throw error;
		}
		render(
			<RouteLoadBoundary
				routeId="models"
				attempt={0}
				onRetry={onRetry}
				checkVersion={vi.fn(async () => versionResult('same'))}
				reload={vi.fn()}
			>
				<Broken />
			</RouteLoadBoundary>,
		);

		await waitFor(() => expect(screen.getByText(/failed to load/i)).toBeInTheDocument());
		fireEvent.click(screen.getByRole('button', { name: /try again/i }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('does not claim a version problem when the page itself throws', async () => {
		const checkVersion = vi.fn(async () => versionResult('changed'));
		function Broken(): null {
			throw new Error('Cannot read properties of undefined');
		}
		render(
			<RouteLoadBoundary
				routeId="models"
				attempt={0}
				onRetry={vi.fn()}
				checkVersion={checkVersion}
				reload={vi.fn()}
			>
				<Broken />
			</RouteLoadBoundary>,
		);

		expect(await screen.findByText(/failed to render/i)).toBeInTheDocument();
		expect(screen.queryByText(/new admin ui version/i)).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /refresh page/i })).not.toBeInTheDocument();
		expect(checkVersion).not.toHaveBeenCalled();
		expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
	});

	it('recreates the lazy instance so an explicit retry can succeed', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () =>
					new Response(JSON.stringify({ buildId: 'test-build' }), {
						status: 200,
						headers: { 'content-type': 'application/json' },
					}),
			),
		);
		function Recovered() {
			return <span>recovered page</span>;
		}
		const load = vi
			.fn()
			.mockRejectedValueOnce(new Error('Failed to fetch dynamically imported module'))
			.mockResolvedValue({ default: Recovered });

		render(
			<MemoryRouter>
				<RoutePage routeId="models" load={load} />
			</MemoryRouter>,
		);

		await screen.findByText(/failed to load/i);
		fireEvent.click(screen.getByRole('button', { name: /try again/i }));
		expect(await screen.findByText('recovered page')).toBeInTheDocument();
		expect(load).toHaveBeenCalledTimes(2);
	});
});
