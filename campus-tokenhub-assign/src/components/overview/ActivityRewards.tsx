'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { appPath } from '@/lib/paths';
import { formatPoints, activityWindowLabel } from '@/lib/activities/rules';
import type { ActivityOverview, ActivityView } from '@/lib/activities/types';

type ClaimResponse = {
  error?: string;
  status?: 'applied' | 'duplicate';
  points?: number;
  amount_yuan?: number;
  balance_yuan?: number | null;
};

function IconClock() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
      <ellipse cx="6.5" cy="6.5" rx="4.66" ry="4.66" stroke="currentColor" strokeWidth="1.4" />
      <path d="M6.5 3.9v2.8l1.8 1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden className="mt-[3px] shrink-0">
      <path d="M2.2 6.3l2.4 2.4 5.2-5.2" stroke="#86909C" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 领取算力：两列活动卡。
 *
 * 状态由服务端算好（时间窗 / 星期 / 本周期是否已领），这里只负责交互：
 * 领取成功后先本地置为已领，再 router.refresh() 用服务端结果覆盖，
 * 避免刷新回来之前按钮还能再点一次。
 */
export function ActivityRewards({ overview }: { overview: ActivityOverview }) {
  const router = useRouter();
  const [views, setViews] = useState<ActivityView[]>(overview.activities);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 待确认领取的活动：点「领取」先弹确认，确认后才真正提交 */
  const [pending, setPending] = useState<ActivityView | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViews(overview.activities);
  }, [overview.activities]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // 弹窗：Esc 关闭 + 打开时把焦点送进去；提交中不允许关闭，避免状态错乱
  useEffect(() => {
    if (!pending) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busyId) return;
      setPending(null);
    };

    document.addEventListener('keydown', onKeyDown);
    // 焦点落在弹窗容器上：读屏会念出对话框，视觉上也不会让某个按钮一开始就带焦点环
    dialogRef.current?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, busyId]);

  async function claim(view: ActivityView): Promise<void> {
    if (busyId) return;
    setBusyId(view.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(appPath('/api/portal/activities'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ activityId: view.id }),
      });
      const body = (await response.json().catch(() => ({}))) as ClaimResponse;
      if (!response.ok) throw new Error(body.error ?? '领取失败，请稍后重试');

      if (body.status === 'duplicate') {
        setNotice(`${view.title} 这个周期已经领过了，额度不会重复发放。`);
      } else {
        const points = body.points ?? view.points;
        setNotice(`已到账 ${formatPoints(points)} 算力值。`);
      }

      setViews((prev) =>
        prev.map((item) =>
          item.id === view.id
            ? { ...item, state: 'claimed', disabled: true, buttonLabel: '已领取', statusLabel: '已叠加到永久额度' }
            : item
        )
      );
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '领取失败');
    } finally {
      setBusyId(null);
    }
  }

  /** 确认弹窗里点「确认领取」：提交完再关弹窗，结果仍走页面上的成功/失败提示 */
  async function confirmClaim(): Promise<void> {
    const view = pending;
    if (!view) return;
    await claim(view);
    setPending(null);
  }

  if (views.length === 0) return null;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold leading-6 text-ink-900">领取算力</h2>
        <p className="text-xs leading-5 text-ink-500">
          近一年累计领取 {formatPoints(overview.totals.points)} 算力值 · {overview.totals.count} 次
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-control border border-[#F5C2BE] bg-[#FDECEA] px-4 py-2 text-sm text-danger">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-control border border-[#BFE3CE] bg-[#E8F5EE] px-4 py-2 text-sm text-success">
          {notice}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        {views.map((view) => {
          const busy = busyId === view.id;
          const windowText = activityWindowLabel(view.startsOn, view.endsOn);

          return (
            <article key={view.id} className="flex flex-col gap-3 rounded-card border border-line bg-white p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 text-[15px] font-semibold leading-6 text-ink-900">{view.title}</h3>
                {view.badge && (
                  <span className="h-5 shrink-0 rounded-[4px] bg-brand-yellow-soft px-1.5 text-[11px] font-medium leading-5 text-brand-yellow">
                    {view.badge}
                  </span>
                )}
              </div>

              {windowText && (
                <p className="flex items-center gap-1.5 text-xs leading-5 text-ink-500">
                  <IconClock />
                  {windowText}
                </p>
              )}

              <p className="flex items-baseline gap-1.5">
                <span className="text-xs leading-5 text-ink-700">每次</span>
                <span className="text-xl font-semibold leading-7 tabular-nums text-ink-900">
                  {formatPoints(view.points)}
                </span>
                <span className="text-xs leading-5 text-ink-700">算力值</span>
              </p>

              {view.summary.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                  {view.summary.map((line) => (
                    <li key={line} className="flex items-start gap-1.5 text-xs leading-5 text-ink-700">
                      <IconCheck />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              )}

              {view.statusLabel && view.state !== 'claimable' && (
                <p className="text-[11px] leading-4 text-brand-yellow">{view.statusLabel}</p>
              )}

              <button
                type="button"
                onClick={() => setPending(view)}
                disabled={view.disabled || busy}
                aria-busy={busy}
                className={`mt-auto h-9 w-full rounded-control text-[13px] font-medium transition ${
                  view.disabled
                    ? 'cursor-not-allowed bg-cream-100 text-ink-400'
                    : 'bg-brand-orange text-white hover:bg-brand-orange-dark'
                }`}
              >
                {busy ? '领取中…' : view.buttonLabel}
              </button>
            </article>
          );
        })}
      </div>

      {overview.degraded && (
        <p className="text-[11px] leading-4 text-ink-500">
          暂时读不到历史领取记录，「已领取」标记可能不准；点击领取时会再校验一次，不会重复发放。
        </p>
      )}

      {pending && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-4"
          onClick={() => {
            if (!busyId) setPending(null);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="claim-confirm-title"
            aria-describedby="claim-confirm-body"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-[372px] rounded-xl bg-white p-6 shadow-[0_8px_24px_-2px_rgba(0,0,0,0.1)] outline-none focus-visible:outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <h3 id="claim-confirm-title" className="text-base font-semibold leading-6 text-ink-900">
                确认领取
              </h3>
              <button
                type="button"
                aria-label="关闭"
                disabled={Boolean(busyId)}
                onClick={() => setPending(null)}
                className="-mr-2 -mt-2 flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-500 transition hover:bg-cream-100 hover:text-ink-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                  <path d="M1 1l8 8M9 1L1 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </button>
            </div>

            <p id="claim-confirm-body" className="mt-4 text-[13px] leading-[21px] text-ink-600">
              即将领取「{pending.title}」，共 {formatPoints(pending.points)} 算力值。确认继续吗？
            </p>

            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={Boolean(busyId)}
                onClick={() => setPending(null)}
                className="flex h-9 items-center rounded-control border border-line px-4 text-[13px] text-ink-700 transition hover:bg-cream-100 disabled:cursor-not-allowed disabled:opacity-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={Boolean(busyId)}
                aria-busy={Boolean(busyId)}
                onClick={confirmClaim}
                className="flex h-9 items-center rounded-control bg-brand-orange px-4 text-[13px] font-medium text-white transition hover:bg-brand-orange-dark disabled:cursor-not-allowed disabled:opacity-60"
              >
                {busyId ? '领取中…' : '确认领取'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
