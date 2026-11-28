'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 登录数据看板：两站登录次数、登录人数、页面访问与人均访问，
 * 按日趋势 + 活跃用户排行（排序与搜索下推数据库，CSV 导出上限 5000 行）。
 *
 * 时间区间复用后台既有的 `AnalyticsRangeControl` + `useAnalyticsRange`，
 * 与服务端契约一致（`start_date` / `end_date`）。
 */

import { useEffect, useMemo, useState, type ComponentType } from 'react';
import {
	ArrowRightOnRectangleIcon,
	ArrowTrendingUpIcon,
	ChartBarIcon,
	EyeIcon,
	TrophyIcon,
	UsersIcon,
} from '@heroicons/react/24/outline';
import { useTranslations } from 'next-intl';
import { AdminPageTitle } from '@/components/admin-page-title';
import { AnalyticsRangeControl } from '@/components/AnalyticsRangeControl';
import { AnalyticsLoadError } from '@/components/AnalyticsInsights';
import { useAnalyticsRange } from '@/lib/use-analytics-range';
import { useActivityEnabled } from '@/lib/use-activity-enabled';
import { adminApiPath } from '@/lib/admin-browser-path';
import { readApiJson } from '@/lib/api-json';
import { csvRowsToString, downloadCsvFile, filenameTimestamp } from '@/lib/csv';
import {
	buildSummaryQuery,
	buildUserCsvRows,
	formatMetric,
	isRangeTooLong,
} from '@/lib/portal-activity/view';
import type { PortalActivitySummary } from '@/lib/portal-activity/service';

type SiteFilter = 'all' | 'assign' | 'member';
type SortKey = 'page_views' | 'logins' | 'active_days' | 'last_active';

const SITE_OPTIONS: SiteFilter[] = ['all', 'assign', 'member'];
const EXPORT_LIMIT = 5000;

function MetricCard({
	label,
	value,
	hint,
	icon: Icon,
	tone,
}: {
	label: string;
	value: string;
	hint?: string;
	icon: ComponentType<{ className?: string }>;
	tone: string;
}) {
	return (
		<div className="admin-summary-metric min-w-0 rounded-xl border border-gray-200 bg-white p-4">
			<p className="flex items-center gap-2 text-xs text-gray-500">
				<span
					className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone}`}
					aria-hidden="true"
				>
					<Icon className="h-4 w-4" />
				</span>
				{label}
			</p>
			<p className="admin-summary-value mt-3 break-words font-mono text-xl font-medium tabular-nums text-gray-900">
				{value}
			</p>
			<p className="mt-2 min-h-4 text-xs tabular-nums text-gray-500">{hint ?? ''}</p>
		</div>
	);
}

function TrendChart({
	trend,
	loginLabel,
	viewLabel,
}: {
	trend: PortalActivitySummary['trend'];
	loginLabel: string;
	viewLabel: string;
}) {
	if (trend.length === 0) return null;

	const width = 640;
	const height = 160;
	const padTop = 12;
	const padBottom = 24;
	const padSide = 12;
	const plotHeight = height - padTop - padBottom;
	const max = Math.max(1, ...trend.map((point) => Math.max(point.logins, point.pageViews)));
	const stepX = trend.length > 1 ? (width - padSide * 2) / (trend.length - 1) : 0;
	// 只有一天数据时 stepX 为 0，把唯一的点放到中间，否则它会贴在左边缘看起来像空图
	const baseX = trend.length > 1 ? padSide : width / 2;

	const toPoints = (pick: (point: PortalActivitySummary['trend'][number]) => number) =>
		trend
			.map((point, index) => {
				const x = baseX + stepX * index;
				const y = padTop + (1 - pick(point) / max) * plotHeight;
				return `${x.toFixed(1)},${y.toFixed(1)}`;
			})
			.join(' ');

	return (
		<div>
			<div className="mb-2 flex items-center gap-4 text-xs text-gray-500">
				<span className="flex items-center gap-1">
					<span className="inline-block h-2 w-2 rounded-full bg-blue-500" aria-hidden="true" />
					{loginLabel}
				</span>
				<span className="flex items-center gap-1">
					<span className="inline-block h-2 w-2 rounded-full bg-teal-500" aria-hidden="true" />
					{viewLabel}
				</span>
			</div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="h-40 w-full"
				role="img"
				aria-label={loginLabel}
			>
				<line
					x1={padSide}
					y1={height - padBottom}
					x2={width - padSide}
					y2={height - padBottom}
					stroke="currentColor"
					className="text-gray-200"
					strokeWidth="1"
					vectorEffect="non-scaling-stroke"
				/>
				<polyline
					points={toPoints((point) => point.logins)}
					fill="none"
					stroke="currentColor"
					className="text-blue-500"
					strokeWidth="2"
					vectorEffect="non-scaling-stroke"
				/>
				<polyline
					points={toPoints((point) => point.pageViews)}
					fill="none"
					stroke="currentColor"
					className="text-teal-500"
					strokeWidth="2"
					vectorEffect="non-scaling-stroke"
				/>
				{trend.length === 1 ? (
					// 单日区间画不出折线，用一根竖线标出当天值，避免整块图看起来是空的
					<line
						x1={baseX}
						y1={height - padBottom}
						x2={baseX}
						y2={padTop + (1 - Math.max(trend[0].logins, trend[0].pageViews) / max) * plotHeight}
						stroke="currentColor"
						className="text-blue-400"
						strokeWidth="2"
						vectorEffect="non-scaling-stroke"
					/>
				) : null}
			</svg>
			<div className="mt-1 flex justify-between text-xs text-gray-400">
				<span>{trend[0]?.day}</span>
				<span>{trend[trend.length - 1]?.day}</span>
			</div>
		</div>
	);
}

export default function LoginActivityPage() {
	const t = useTranslations('analytics.loginActivity');
	// 门户设置页的总开关：默认关闭，未读到前也不发请求
	const activityEnabled = useActivityEnabled();
	const [rangeValue, setRangeValue] = useAnalyticsRange(true);
	const [site, setSite] = useState<SiteFilter>('all');
	const [sort, setSort] = useState<SortKey>('page_views');
	const [search, setSearch] = useState('');
	const [committedSearch, setCommittedSearch] = useState('');
	const [data, setData] = useState<PortalActivitySummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [exportFailed, setExportFailed] = useState(false);
	const [refreshToken, setRefreshToken] = useState(0);
	const [exporting, setExporting] = useState(false);

	// 搜索防抖：输入框每次按键都发请求会把数据库打满
	useEffect(() => {
		const timer = setTimeout(() => setCommittedSearch(search.trim()), 300);
		return () => clearTimeout(timer);
	}, [search]);

	const tooLong = isRangeTooLong(rangeValue.start_date, rangeValue.end_date);

	useEffect(() => {
		if (activityEnabled !== true) {
			// 开关关闭（或还没读到）不请求：接口本身也会 403，没必要先打一发
			setLoading(false);
			return;
		}
		if (tooLong) {
			setLoading(false);
			return;
		}

		const controller = new AbortController();
		setLoading(true);
		setFailed(false);

		const params = buildSummaryQuery(rangeValue, { site, sort, q: committedSearch });

		fetch(adminApiPath(`/api/admin/portal-activity/summary?${params}`), {
			signal: controller.signal,
		})
			.then((response) => readApiJson<PortalActivitySummary>(response))
			.then((payload) => {
				if (controller.signal.aborted) return;
				if (!payload.success || !payload.data) {
					throw new Error(payload.message ?? 'summary failed');
				}
				setData(payload.data);
			})
			.catch((error) => {
				if (controller.signal.aborted) return;
				console.error('Fetch portal activity error:', error);
				setFailed(true);
			})
			.finally(() => {
				if (!controller.signal.aborted) setLoading(false);
			});

		return () => controller.abort();
	}, [rangeValue, site, sort, committedSearch, refreshToken, tooLong, activityEnabled]);

	const kpiCards = useMemo(() => {
		const kpi = data?.kpi;
		return [
			{
				key: 'logins',
				label: t('kpi.logins'),
				value: formatMetric(kpi?.logins ?? 0),
				icon: ArrowRightOnRectangleIcon,
				tone: 'bg-blue-50 text-blue-700',
			},
			{
				key: 'loginUsers',
				label: t('kpi.loginUsers'),
				value: formatMetric(kpi?.loginUsers ?? 0),
				icon: UsersIcon,
				tone: 'bg-emerald-50 text-emerald-700',
			},
			{
				key: 'pageViews',
				label: t('kpi.pageViews'),
				value: formatMetric(kpi?.pageViews ?? 0),
				icon: EyeIcon,
				tone: 'bg-indigo-50 text-indigo-700',
			},
			{
				key: 'pvPerUser',
				label: t('kpi.pvPerUser'),
				value: formatMetric(kpi?.pvPerUser ?? 0),
				hint: t('kpi.activeHint', { count: formatMetric(kpi?.activeUsers ?? 0) }),
				icon: ChartBarIcon,
				tone: 'bg-amber-50 text-amber-700',
			},
		];
	}, [data, t]);

	const toggleSort = (next: SortKey) => {
		setSort((current) => (current === next ? current : next));
	};

	const handleExport = async () => {
		if (!data || exporting) return;
		setExporting(true);
		setExportFailed(false);
		try {
			const params = buildSummaryQuery(rangeValue, {
				site,
				sort,
				q: committedSearch,
				limit: EXPORT_LIMIT,
			});
			const response = await fetch(adminApiPath(`/api/admin/portal-activity/summary?${params}`));
			const payload = await readApiJson<PortalActivitySummary>(response);
			if (!payload.success || !payload.data) throw new Error(payload.message ?? 'export failed');
			downloadCsvFile(
				`portal-activity-${filenameTimestamp()}.csv`,
				csvRowsToString(buildUserCsvRows(payload.data.users))
			);
		} catch (error) {
			console.error('Export portal activity error:', error);
			// 导出失败只影响这一次下载，不能把整页打成「加载失败」把已有数据藏起来
			setExportFailed(true);
		} finally {
			setExporting(false);
		}
	};

	if (activityEnabled === false) {
		return (
			<div className="admin-content-workspace content-tone-analytics min-w-0 space-y-6 p-4 sm:p-6 lg:p-8">
				<div>
					<AdminPageTitle>{t('title')}</AdminPageTitle>
					<p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
				</div>
				<div className="admin-content-panel rounded-xl border border-gray-200 bg-white p-10 text-center">
					<p className="text-sm font-medium text-gray-700">{t('disabled')}</p>
					<p className="mt-2 text-xs text-gray-500">{t('disabledHint')}</p>
				</div>
			</div>
		);
	}

	const columns: { key: SortKey; label: string }[] = [
		{ key: 'logins', label: t('columns.logins') },
		{ key: 'page_views', label: t('columns.pageViews') },
		{ key: 'active_days', label: t('columns.activeDays') },
		{ key: 'last_active', label: t('columns.lastActive') },
	];

	return (
		<div className="admin-content-workspace content-tone-analytics min-w-0 space-y-6 p-4 sm:p-6 lg:p-8">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<AdminPageTitle>{t('title')}</AdminPageTitle>
					<p className="mt-1 text-sm text-gray-500">{t('subtitle')}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<select
						value={site}
						onChange={(event) => setSite(event.target.value as SiteFilter)}
						className="h-9 rounded-lg border border-gray-200 bg-white px-2 text-sm text-gray-700"
						aria-label={t('columns.site')}
					>
						{SITE_OPTIONS.map((option) => (
							<option key={option} value={option}>
								{t(`site.${option}`)}
							</option>
						))}
					</select>
					<AnalyticsRangeControl value={rangeValue} onChange={setRangeValue} />
					<button
						type="button"
						onClick={handleExport}
						disabled={!data || exporting || loading}
						className="h-9 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700 disabled:opacity-50"
					>
						{t('rank.export')}
					</button>
					{exportFailed ? (
						<span role="alert" className="text-xs text-red-600">
							{t('exportFailed')}
						</span>
					) : null}
				</div>
			</div>

			{tooLong ? (
				<p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">{t('rangeTooLong')}</p>
			) : null}

			{!tooLong && failed ? (
				<AnalyticsLoadError onRetry={() => setRefreshToken((value) => value + 1)} />
			) : null}

			<div className="admin-summary-canvas grid grid-cols-2 gap-3 xl:grid-cols-4">
				{kpiCards.map((card) => (
					<MetricCard
						key={card.key}
						label={card.label}
						value={card.value}
						hint={card.hint}
						icon={card.icon}
						tone={card.tone}
					/>
				))}
			</div>

			<div>
				<h2 className="admin-section-title mb-3 flex items-center gap-2 text-base font-medium text-gray-900">
					<ArrowTrendingUpIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
					{t('trend.title')}
				</h2>
				<section className="admin-content-panel rounded-xl border border-gray-200 bg-white p-4">
				{loading && !data ? (
					<p className="py-10 text-center text-sm text-gray-400">{t('loading')}</p>
				) : data && data.trend.length > 0 && data.kpi.logins + data.kpi.pageViews > 0 ? (
					<TrendChart
						trend={data.trend}
						loginLabel={t('trend.logins')}
						viewLabel={t('trend.pageViews')}
					/>
				) : (
					<p className="py-10 text-center text-sm text-gray-400">{t('empty')}</p>
				)}
				</section>
			</div>

			<div>
				<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
					<h2 className="admin-section-title flex items-center gap-2 text-base font-medium text-gray-900">
						<TrophyIcon className="h-4 w-4 text-gray-400" aria-hidden="true" />
						{t('rank.title')}
					</h2>
					<input
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t('rank.search')}
						className="h-9 w-56 rounded-lg border border-gray-200 bg-white px-3 text-sm text-gray-700"
					/>
				</div>

				<div className="admin-content-panel admin-table-surface overflow-hidden rounded-xl border border-gray-200 bg-white">
					<div className="overflow-x-auto">
					<table className="admin-data-table w-full table-fixed text-left text-sm">
						<thead>
							<tr className="text-xs text-gray-500">
								<th className="w-[34%] px-4 py-3 font-normal">{t('columns.user')}</th>
								<th className="w-[12%] px-4 py-3 font-normal">{t('columns.site')}</th>
								{columns.map((column) => (
									<th key={column.key} className="w-[12%] px-4 py-3 font-normal">
										<button
											type="button"
											onClick={() => toggleSort(column.key)}
											className={sort === column.key ? 'text-gray-900' : 'hover:text-gray-700'}
										>
											{column.label}
											{sort === column.key ? ' ↓' : ''}
										</button>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data?.users.map((user) => (
								<tr key={user.sub} className="border-b border-gray-100 last:border-0">
									<td className="px-4 py-3">
										<div className="truncate text-gray-900">{user.name ?? '—'}</div>
										<div className="truncate text-xs text-gray-500">{user.email ?? user.sub}</div>
									</td>
									<td className="px-4 py-3 text-gray-600">{t(`site.${user.site}`)}</td>
									<td className="px-4 py-3 tabular-nums text-gray-700">{formatMetric(user.logins)}</td>
									<td className="px-4 py-3 tabular-nums text-gray-700">
										{formatMetric(user.pageViews)}
									</td>
									<td className="px-4 py-3 tabular-nums text-gray-700">
										{formatMetric(user.activeDays)}
									</td>
									<td className="px-4 py-3 text-xs text-gray-500">
										{user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleString() : '—'}
									</td>
								</tr>
							))}
						</tbody>
					</table>
					</div>
				</div>

				{loading ? (
					<p className="py-8 text-center text-sm text-gray-400">{t('loading')}</p>
				) : data && data.users.length === 0 ? (
					<p className="py-8 text-center text-sm text-gray-400">{t('empty')}</p>
				) : null}
			</div>
		</div>
	);
}
