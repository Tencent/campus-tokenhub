import Link from 'next/link';
import { Suspense } from 'react';
import { requireCurrentSession } from '@/lib/auth/current';
import { getUser } from '@/lib/gateway/users';
import { listKeys } from '@/lib/gateway/keys';
import { budgetPeriodLabel, formatDateTime } from '@/lib/gateway/format';
import { getUsageSummary, type UsageWindow } from '@/lib/gateway/usage-dashboard';
import { getTpmSeries } from '@/lib/gateway/tpm-series';
import type { GatewayUser } from '@/lib/gateway/types';
import { ACTIVITY_TIME_ZONE } from '@/lib/activities/rules';
import { formatPointsFromYuan } from '@/lib/portal/points';
import { readRpmLimit } from '@/lib/portal/rate-limit';
import { KeyManager } from '@/components/keys/KeyManager';
import { ProvisionRetry } from '@/components/portal/ProvisionRetry';
import { SkeletonCard, SkeletonRegion } from '@/components/portal/Skeleton';
import { ActivityRewards } from '@/components/overview/ActivityRewards';
import { getActivityOverview } from '@/lib/activities/overview';

export const dynamic = 'force-dynamic';

/** 业务时区下的当前自然月（YYYY-MM），用来从 30 天序列里筛出「本月」 */
function monthPrefixInTimeZone(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: ACTIVITY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
}

function IconInfo() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden className="shrink-0">
      <ellipse cx="7" cy="7" rx="5.25" ry="5.25" stroke="#86909C" strokeWidth="1.2" />
      <path d="M7 6.4v3.2" stroke="#86909C" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="7" cy="4.6" r="0.6" fill="#86909C" />
    </svg>
  );
}

function IconArrow({ className = '' }: { className?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className={className}>
      <path d="M2.5 6h6.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M6.25 3l3 3-3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatusBanner({ status }: { status: string }) {
  if (status === 'active') return null;
  return (
    <div className="rounded-card border border-[#F5C2BE] bg-[#FDECEA] px-4 py-3 text-sm leading-5 text-danger">
      账号已被停用（状态：{status}），请联系管理员。当前页面仅可查看，无法创建或使用密钥。
    </div>
  );
}

/** 算力账户卡：周期额度（含进度） + 永久额度 + 每分钟请求峰值 + 扣减顺序说明 */
function AccountCard({
  user,
  failed,
  peakRpm,
}: {
  user: GatewayUser | null;
  failed: boolean;
  /** 今日每分钟请求峰值；读不到时为 null */
  peakRpm: number | null;
}) {
  if (failed || !user) {
    return (
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-card border border-line bg-white p-6">
        <div>
          <h2 className="text-base font-semibold leading-6 text-ink-900">账户未开通</h2>
          <p className="mt-1 text-xs leading-5 text-ink-500">暂时读不到账户信息，可以稍后刷新，或重新尝试开通。</p>
        </div>
      </section>
    );
  }

  const spent = user.budget_spent ?? 0;
  const max = user.budget_max ?? null;
  const remain = max === null ? null : Math.max(0, max - spent);
  const usedPercent = max && max > 0 ? Math.min(100, Math.round((spent / max) * 100)) : 0;
  const remainPercent = max && max > 0 ? Math.max(0, 100 - usedPercent) : null;
  const exhausted = max !== null && spent >= max;
  const nearly = !exhausted && usedPercent >= 90;
  const bar = exhausted ? 'bg-danger' : nearly ? 'bg-brand-yellow' : 'bg-brand-orange';
  const wallet = user.wallet_balance ?? Math.max(0, (user.wallet_granted ?? 0) - (user.wallet_spent ?? 0));
  const rpm = readRpmLimit(user.rate_limit);

  return (
    <section className="flex flex-col gap-4 rounded-card border border-line bg-white p-6">
      <div className="flex flex-col gap-10 lg:flex-row">
        <div className="flex w-full flex-col gap-2 lg:w-[360px] lg:shrink-0">
          <div className="flex h-5 flex-wrap items-center justify-between gap-x-3">
            <span className="text-xs leading-5 text-ink-500">
              周期额度（{budgetPeriodLabel(user.budget_period)}）
            </span>
            <span className="text-xs leading-5 text-ink-500">下次重置 {formatDateTime(user.budget_reset_at)}</span>
          </div>

          <div className="flex items-baseline gap-2">
            <span className="text-[32px] font-bold leading-none tracking-tight tabular-nums text-ink-900">
              {remain === null ? '不限' : formatPointsFromYuan(remain)}
            </span>
            <span className="text-[13px] leading-5 text-ink-500">
              {max === null ? '' : `/ ${formatPointsFromYuan(max)} 算力值`}
            </span>
          </div>

          <div className="mt-2 h-2 w-full overflow-hidden rounded-[4px] bg-[#EDEFF3]">
            <div className={`h-full rounded-[4px] transition-all ${bar}`} style={{ width: `${usedPercent}%` }} />
          </div>

          <div className="flex items-center justify-between gap-3 text-xs leading-5 text-ink-500">
            <span>{remainPercent === null ? '额度不限' : `余量 ${remainPercent}%`}</span>
            <span>已用 {formatPointsFromYuan(spent)} 算力值</span>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2 lg:w-[320px] lg:shrink-0">
          <span className="flex h-5 items-center text-xs leading-5 text-ink-500">
            永久额度（加油包 · 不限使用时间）
          </span>
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold leading-8 tabular-nums text-ink-900">
              {formatPointsFromYuan(wallet)}
            </span>
            <span className="text-xs leading-5 text-ink-500">算力值</span>
          </p>
        </div>

        <div className="flex w-full flex-col gap-2 lg:w-[240px] lg:shrink-0">
          <span className="flex h-5 items-center text-xs leading-5 text-ink-500">每分钟最大请求数（RPM）</span>
          <p className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold leading-8 tabular-nums text-ink-900">
              {peakRpm === null ? '—' : peakRpm.toLocaleString('zh-CN')}
            </span>
          </p>
          <span className="text-[11px] leading-4 text-ink-500">
            今日峰值 · {rpm === null ? '未设置上限' : `上限 ${rpm.toLocaleString('zh-CN')}`}
          </span>
        </div>
      </div>

      <div className="h-px w-full bg-[#EDEFF3]" />

      <p className="flex items-center gap-1.5 text-xs leading-5 text-ink-500">
        <IconInfo />
        {exhausted
          ? '周期额度已用尽，后续调用将开始扣减永久额度'
          : '算力值扣减顺序：先扣周期额度，再扣永久额度'}
      </p>
    </section>
  );
}

/** 迷你趋势线：面积 + 折线，只表达形状，不带坐标轴 */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-14 w-full" />;

  const width = 320;
  const height = 56;
  const peak = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const coords = values.map((value, index) => {
    const x = index * step;
    const y = height - 4 - (value / peak) * (height - 10);
    return [x, y] as const;
  });
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-14 w-full" aria-hidden>
      <path d={area} fill="rgba(37, 87, 214, 0.08)" />
      <path d={line} fill="none" stroke="#2557D6" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** 用量速览：今日 / 本月消耗 + 本月调用 + 迷你趋势线 */
function UsageOverviewCard({ usage }: { usage: UsageWindow | null }) {
  const series = usage?.series ?? [];
  const monthPrefix = monthPrefixInTimeZone();
  const monthSeries = series.filter((item) => item.day.startsWith(monthPrefix));
  const todayCost = series.length > 0 ? series[series.length - 1].cost : null;
  const monthCost = monthSeries.reduce((sum, item) => sum + item.cost, 0);
  const monthRequests = monthSeries.reduce((sum, item) => sum + item.requests, 0);
  const hasData = monthSeries.length > 0 && !usage?.degraded;
  /** 全月零消耗时不画趋势线：一条贴底的折线会被误读成分隔线 */
  const hasTrend = hasData && monthSeries.some((item) => item.cost > 0);

  const metrics = [
    { label: '今日消耗（算力值）', value: todayCost === null ? '—' : formatPointsFromYuan(todayCost) },
    { label: '本月消耗（算力值）', value: hasData ? formatPointsFromYuan(monthCost) : '—' },
    { label: '本月调用次数（次）', value: hasData ? monthRequests.toLocaleString('zh-CN') : '—' },
  ];

  return (
    <section className="flex flex-col gap-3.5 rounded-card border border-line bg-white p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold leading-6 text-ink-900">用量速览</h2>
        <Link
          href="/dashboard"
          className="flex items-center gap-1 text-xs font-medium leading-4 text-brand-orange transition hover:text-brand-orange-dark"
        >
          查看更多
          <IconArrow />
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-x-9 gap-y-4">
        {metrics.map((metric) => (
          <div key={metric.label} className="flex flex-col gap-1">
            <span className="text-xs leading-5 text-ink-500">{metric.label}</span>
            <span className="text-xl font-semibold leading-7 tabular-nums text-ink-900">{metric.value}</span>
          </div>
        ))}
        {hasTrend && (
          <div className="min-w-[160px] flex-1">
            <Sparkline values={monthSeries.map((item) => item.cost)} />
          </div>
        )}
      </div>

      {usage?.degraded && (
        <p className="text-[11px] leading-4 text-ink-500">用量统计暂时读不到，上面的数字仅供参考。</p>
      )}
    </section>
  );
}

/** 无活动时的引导卡（设计稿 P1-B）：把注意力从「领额度」切到「建 Key」 */
function GettingStartedCard({ hasKey }: { hasKey: boolean }) {
  return (
    <section className="flex flex-wrap items-center justify-between gap-6 rounded-card border border-line bg-white p-6">
      <div className="flex min-w-0 flex-col gap-1.5">
        <h2 className="text-base font-semibold leading-6 text-ink-900">开始使用</h2>
        <p className="text-[13px] leading-5 text-ink-700">
          学校已按学期为你的账号分配算力额度。创建一个 API Key，即可接入常用的 AI 工具。
        </p>
      </div>

      <a
        href="#my-api-key"
        className="flex h-10 shrink-0 items-center gap-1.5 rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark"
      >
        {hasKey ? null : (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
            <path d="M6 2.5v7M2.5 6h7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
        {hasKey ? '查看密钥' : '创建 API Key'}
      </a>
    </section>
  );
}

/** 数据区：只负责取数，外壳已经先渲染出去了 */
async function OverviewData({ userId }: { userId: string }) {
  const [userResult, keysResult, activityResult, usageResult, tpmResult] = await Promise.allSettled([
    getUser(userId),
    listKeys(userId),
    getActivityOverview(userId),
    getUsageSummary(userId, 30),
    // 今日的每分钟请求峰值：与看板折线图同源，用于账号卡的 RPM
    getTpmSeries(userId, '24h'),
  ]);

  const user = userResult.status === 'fulfilled' ? userResult.value : null;
  const keys = keysResult.status === 'fulfilled' ? keysResult.value : [];
  const activities = activityResult.status === 'fulfilled' ? activityResult.value : null;
  const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
  const tpm = tpmResult.status === 'fulfilled' ? tpmResult.value : null;
  const peakRpm = tpm?.stats.peak_rpm ?? null;
  const activeKey = keys.find((key) => key.status === 'active') ?? null;

  return (
    <>
      {user && <StatusBanner status={user.status} />}

      <div className="space-y-4">
        <AccountCard user={user} failed={userResult.status === 'rejected'} peakRpm={peakRpm} />
        <UsageOverviewCard usage={usage} />
        {activities && activities.activities.length > 0 ? (
          <ActivityRewards overview={activities} />
        ) : (
          <GettingStartedCard hasKey={Boolean(activeKey)} />
        )}
        {/* 密钥放页面最下面：额度、用量、活动先铺开，取用凭证作为最后一屏的操作 */}
        <KeyManager
          initialKeys={keys}
          ready
          loadFailed={keysResult.status === 'rejected'}
          accountStatus={user?.status ?? null}
        />
      </div>
    </>
  );
}

export default async function OverviewPage() {
  const session = await requireCurrentSession();

  if (!session.octafuse_user_id) {
    return (
      <div className="mx-auto max-w-2xl">
        <section className="rounded-card border border-brand-yellow/40 bg-brand-yellow-soft p-6">
          <h2 className="text-base font-semibold text-ink-900">账号正在开通中</h2>
          <p className="mt-2 text-sm leading-relaxed text-ink-700">
            你的身份已验证，但账号还没有开通（可能是服务暂时不可用）。
            点击下面的按钮重试，开通后会自动刷新本页。
          </p>
          <ProvisionRetry />
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Suspense
        fallback={
          <SkeletonRegion className="space-y-4">
            <SkeletonCard rows={2} />
            <SkeletonCard rows={2} />
            <SkeletonCard rows={3} />
          </SkeletonRegion>
        }
      >
        <OverviewData userId={session.octafuse_user_id} />
      </Suspense>
    </div>
  );
}
