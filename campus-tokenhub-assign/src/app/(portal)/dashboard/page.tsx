import Link from 'next/link';
import { requireCurrentSession } from '@/lib/auth/current';
import { getUsageDashboard, type UsageRange } from '@/lib/gateway/usage-dashboard';
import { getLogsPage } from '@/lib/gateway/keys';
import { getCatalog } from '@/lib/gateway/catalog';
import type { GatewayRequestLog } from '@/lib/gateway/types';
import { formatDateTime } from '@/lib/gateway/format';
import { formatPointsFromYuan, POINTS_PER_YUAN } from '@/lib/portal/points';
import { formatTokens } from '@/lib/portal/usage-format';
import { UsageTrendChart } from '@/components/dashboard/UsageTrendChart';
import { ModelDonut } from '@/components/dashboard/ModelDonut';
import { ExportCsvButton } from '@/components/dashboard/ExportCsvButton';
import { TrendFilters } from '@/components/dashboard/TrendFilters';
import { RangeTabs } from '@/components/dashboard/RangeTabs';
import { RangeNavProvider, RangePendingVeil } from '@/components/dashboard/range-nav';
import { HourlyActivity } from '@/components/dashboard/HourlyActivity';
import { CallLogTable, type CallLogRow } from '@/components/dashboard/CallLogTable';

export const dynamic = 'force-dynamic';

const RANGE_KEYS: UsageRange[] = ['24h', '3d', '7d', '30d'];
const PAGE_SIZE = 20;

/**
 * 区间文案。`24h` 与 `/summary`、TPM 曲线一致按业务自然日对齐，
 * 所以这里写「今日」而不是「近 24 小时」，避免 0 点后标签与数据对不上。
 */
const RANGE_LABEL: Record<UsageRange, string> = {
  '24h': '今日',
  '3d': '近 3 天',
  '7d': '近 7 天',
  '30d': '近 30 天',
};

const STATUS_KEYS = ['all', 'success', 'error'] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

function parseRange(raw: string | undefined): UsageRange {
  return RANGE_KEYS.includes(raw as UsageRange) ? (raw as UsageRange) : '7d';
}

function parseStatus(raw: string | undefined): StatusKey {
  return STATUS_KEYS.includes(raw as StatusKey) ? (raw as StatusKey) : 'all';
}

/** Token 数按「亿 / 万」压缩，与设计稿的大数字排版一致 */
function formatCompactTokens(value: number): string {
  if (!value) return '0';
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)} 亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)} 万`;
  return value.toLocaleString('zh-CN');
}

/** 明细里的算力值保留 1 位小数：单次调用往往只有几算力值，取整会全变成 0 */
function formatPointsPrecise(yuan: number): string {
  const points = yuan * POINTS_PER_YUAN;
  if (!Number.isFinite(points)) return '0';
  if (Math.abs(points) >= 100) return Math.round(points).toLocaleString('zh-CN');
  return (Math.round(points * 10) / 10).toLocaleString('zh-CN');
}

function KpiCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: string;
  sub: string;
  /** 与上一周期相比的百分比；null 表示上一周期没有数据 */
  delta?: number | null;
}) {
  return (
    <div className="flex h-[106px] flex-col justify-between rounded-card border border-line bg-white px-[18px] py-4">
      <p className="text-xs leading-5 text-ink-500">{label}</p>
      <p className="text-2xl font-semibold leading-8 tabular-nums text-ink-900">{value}</p>
      <p className="flex flex-wrap items-center gap-x-1 text-xs leading-5 text-ink-500">
        <span>{sub}</span>
        {delta !== null && delta !== undefined && (
          <span className={delta >= 0 ? 'text-success' : 'text-danger'}>
            · 较上周期 {delta >= 0 ? '+' : ''}
            {delta.toFixed(1)}%
          </span>
        )}
      </p>
    </div>
  );
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; page?: string; status?: string; model?: string; tm?: string; tk?: string }>;
}) {
  const session = await requireCurrentSession();
  const params = await searchParams;
  const activeRange = parseRange(params.range);
  const activeStatus = parseStatus(params.status);
  const activeModel = (params.model ?? 'all').trim() || 'all';
  const trendModel = (params.tm ?? 'all').trim() || 'all';
  const trendKey = (params.tk ?? 'all').trim() || 'all';
  const rangeLabel = RANGE_LABEL[activeRange];
  const pageNo = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1);

  /**
   * 切区间时保留当前筛选条件（模型 / 趋势维度 / 状态），只把页码重置回第一页。
   * 直接用 `?range=x&status=y` 拼串会把 model/tm/tk 静默丢掉。
   */
  const rangeHref = (range: UsageRange): string => {
    const next = new URLSearchParams({ range });
    if (activeStatus !== 'all') next.set('status', activeStatus);
    if (activeModel !== 'all') next.set('model', activeModel);
    if (trendModel !== 'all') next.set('tm', trendModel);
    if (trendKey !== 'all') next.set('tk', trendKey);
    return `?${next.toString()}`;
  };

  if (!session.octafuse_user_id) {
    return (
      <div className="mx-auto max-w-2xl">
        <section className="rounded-card border border-brand-yellow/40 bg-brand-yellow-soft p-6">
          <h2 className="text-base font-semibold text-ink-900">账号正在开通中</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-700">
            账号开通后，这里会自动出现你的用量数据。
            <Link href="/overview" className="mx-1 font-medium text-brand-orange hover:underline">
              去我的算力页重试开通
            </Link>
          </p>
        </section>
      </div>
    );
  }

  const userId = session.octafuse_user_id;

  // 三路取数互不依赖：串行会让首屏多等一整轮网关往返，这里一次并发发出去
  const [data, catalog, logsResult] = await Promise.all([
    getUsageDashboard(userId, activeRange),
    // 模型名映射：只用于把 model_id 显示成可读名称，失败时退回 id
    getCatalog().catch(() => null),
    // 明细取数失败不让整页 500：表格区降级为提示，KPI 与图表照常
    getLogsPage(userId, {
      page: pageNo,
      pageSize: PAGE_SIZE,
      status: activeStatus === 'all' ? undefined : activeStatus,
      modelId: activeModel === 'all' ? undefined : activeModel,
    }).then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const, value: { items: [] as GatewayRequestLog[], total: 0 } })
    ),
  ]);

  const logs = logsResult.value;
  const logsFailed = !logsResult.ok;

  const kpis = data.kpis;
  const days = data.days;
  const totalTokens = kpis ? kpis.tokens.input + kpis.tokens.output : 0;
  const cacheRead = kpis?.tokens.cache_read ?? 0;
  const cacheRate =
    kpis && kpis.tokens.input + cacheRead > 0 ? cacheRead / (kpis.tokens.input + cacheRead) : 0;
  const dailyAverage = kpis && days > 0 ? Math.round(kpis.requests / days) : 0;

  const modelNames = new Map(
    (catalog?.models ?? []).map((model) => [model.id, model.display_name || model.id] as const)
  );
  const displayModel = (id: string | null): string => (id ? modelNames.get(id) ?? id : '—');

  const keyNames = new Map(data.keys.map((key) => [key.id, key.name] as const));

  // 环形图的占比口径要全图统一：只要有消耗就都按金额，全零才都按调用次数。
  // 逐模型判断会出现「一部分按钱、一部分按次数」，提示框的数字无法比较。
  const donutByCost = data.models.some((model) => model.cost > 0);
  const donutItems = data.models.map((model) => ({
    name: displayModel(model.model_id),
    value: donutByCost ? model.cost : model.requests,
  }));

  const rows: CallLogRow[] = logs.items.map((log) => ({
    id: log.id,
    time: formatDateTime(log.created_at),
    model: displayModel(log.model_id),
    keyName: (log.api_key_id && keyNames.get(log.api_key_id)) || '—',
    inputTokens: (log.input_tokens ?? 0).toLocaleString('zh-CN'),
    outputTokens: (log.output_tokens ?? 0).toLocaleString('zh-CN'),
    points: formatPointsPrecise(Number(log.charged_cost ?? 0)),
    latency: log.latency_ms ? `${(log.latency_ms / 1000).toFixed(1)}s` : '—',
    // 网关的失败状态是 `failed`，历史数据里也出现过 `error`；取消/未完成单独展示，别混成 other
    status:
      log.status === 'success'
        ? 'success'
        : log.status === 'error' || log.status === 'failed'
          ? 'error'
          : log.status === 'cancelled'
            ? 'cancelled'
            : log.status === 'incomplete'
              ? 'incomplete'
              : 'other',
    requestBody: log.request_body ?? null,
    errorMessage: log.error_message ?? null,
  }));

  /** 与上一周期相比的百分比；上一周期为 0 时不显示，避免出现 +∞ */
  const deltaOf = (current: number, previous: number): number | null =>
    previous > 0 ? ((current - previous) / previous) * 100 : null;

  const filterModels = data.models.map((model) => ({
    id: model.model_id,
    name: displayModel(model.model_id),
  }));

  /** 趋势序列：按密钥 → 按模型 → 全部，三者取一个（互斥） */
  const trendCostByDay = ((): Map<string, number> | null => {
    const source =
      trendKey !== 'all'
        ? data.seriesByKey.find((item) => item.key_id === trendKey)
        : trendModel !== 'all'
          ? data.seriesByModel.find((item) => item.model_id === trendModel)
          : null;
    if (!source) return null;
    return new Map(source.points.map((point) => [point.day, point.cost] as const));
  })();

  // 不筛选时把调用次数与 Token 一并带到提示框，避免只有一个折算后的算力值
  const trendPoints = data.series.map((item) => {
    const value = trendCostByDay ? trendCostByDay.get(item.day) ?? 0 : item.cost;
    return trendCostByDay
      ? { label: item.day, value }
      : { label: item.day, value, requests: item.requests, tokens: item.tokens };
  });

  // 导出与图表保持一致：带筛选时只有「日期 + 算力值」，不带筛选才给完整四列。
  // 金额统一折算成算力值，避免导出文件与页面上的口径对不上。
  const toPointsCell = (cost: number): string => (cost * POINTS_PER_YUAN).toFixed(2);
  const csvHeaders = trendCostByDay ? ['日期', '算力值'] : ['日期', '调用次数', 'Token', '算力值'];
  const csvRows = trendCostByDay
    ? trendPoints.map((point) => [point.label, toPointsCell(point.value)])
    : data.series.map((item) => [item.day, item.requests, item.tokens, toPointsCell(item.cost)]);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label={`${rangeLabel}累计 Token`}
          value={kpis ? formatCompactTokens(totalTokens) : '—'}
          sub={
            kpis
              ? `输入 ${formatTokens(kpis.tokens.input)} · 输出 ${formatTokens(kpis.tokens.output)}`
              : '汇总数据暂不可用'
          }
          delta={deltaOf(totalTokens, data.previous.tokens.input + data.previous.tokens.output)}
        />
        <KpiCard
          label={`${rangeLabel}消耗算力值`}
          value={kpis ? formatPointsFromYuan(kpis.cost) : '—'}
          sub="按实际调用结算"
          delta={deltaOf(kpis?.cost ?? 0, data.previous.cost)}
        />
        <KpiCard
          label="调用次数"
          value={kpis ? kpis.requests.toLocaleString('zh-CN') : '—'}
          sub={kpis ? `日均 ${dailyAverage} 次` : '汇总数据暂不可用'}
          delta={deltaOf(kpis?.requests ?? 0, data.previous.requests)}
        />
        <KpiCard
          label="缓存节省"
          value={formatCompactTokens(cacheRead)}
          sub={kpis ? `缓存命中 ${(cacheRate * 100).toFixed(1)}%` : '汇总数据暂不可用'}
          delta={deltaOf(cacheRead, data.previous.tokens.cache_read)}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-[18px]">
          {/* 区间切换的乐观高亮与局部 loading 都在 provider 内：tabs 与图表共用一份 pending 状态 */}
          <RangeNavProvider activeRange={activeRange}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold leading-6 text-ink-900">消耗趋势</h2>
              <div className="flex flex-wrap items-center gap-3">
                <TrendFilters models={filterModels} keys={data.keys} />
                <RangeTabs
                  items={RANGE_KEYS.map((item) => ({
                    key: item,
                    label: RANGE_LABEL[item],
                    href: rangeHref(item),
                    active: item === activeRange,
                  }))}
                />
                <ExportCsvButton
                  headers={csvHeaders}
                  rows={csvRows}
                  filename={`usage-${activeRange}${trendModel !== 'all' ? `-${trendModel}` : ''}.csv`}
                />
              </div>
            </div>

            {data.degraded.summary ? (
              <div className="flex min-h-[240px] flex-1 items-center justify-center rounded-control bg-cream/50 text-xs text-ink-500">
                用量汇总暂时读取失败，稍后刷新重试
              </div>
            ) : (
              <RangePendingVeil className="min-h-[240px] flex-1">
                <UsageTrendChart points={trendPoints} className="h-full" />
              </RangePendingVeil>
            )}
          </RangeNavProvider>
        </section>

        <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-[18px]">
          <h2 className="text-base font-semibold leading-6 text-ink-900">模型使用分布</h2>
          <ModelDonut items={donutItems} metric={donutByCost ? 'points' : 'requests'} />
        </section>
      </div>

      <HourlyActivity points={data.hourly} />

      <section className="rounded-card border border-line bg-white p-[18px]">
        <CallLogTable
          rows={rows}
          total={logs.total}
          page={pageNo}
          pageSize={PAGE_SIZE}
          range={activeRange}
          status={activeStatus}
          model={activeModel}
          models={filterModels}
          degraded={logsFailed}
        />
      </section>

      <p className="text-[11px] leading-4 text-ink-500">
        数据每 5 分钟汇总一次；算力值为预算预估，最终以实际结算为准。
      </p>
    </div>
  );
}
