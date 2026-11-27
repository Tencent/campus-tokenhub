'use client';

import { activityWindowLabel, formatPoints } from '@/lib/activities/rules';
import type { TokenActivityConfig } from '@/lib/activities/types';

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
 * 学生端「领取算力」卡片的只读预览。
 *
 * 与 `ActivityRewards` 的卡片同款样式，但不接领取逻辑：按钮置灰不可点，
 * 让管理员在保存前就能看到学生实际会看到的样子。只渲染上架中的活动。
 */
export function ActivityPreview({ activities }: { activities: TokenActivityConfig[] }) {
  const visible = activities.filter((activity) => activity.enabled !== false);

  if (visible.length === 0) {
    return (
      <p className="rounded-card border border-dashed border-line bg-white px-4 py-6 text-center text-xs leading-5 text-ink-500">
        没有上架中的活动。学生端不会出现「领取算力」区，会显示「开始使用」引导卡。
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {visible.map((activity) => {
        const windowText = activityWindowLabel(activity.startsOn, activity.endsOn);
        const summary = activity.summary.filter((line) => line.trim());

        return (
          <article
            key={activity.id}
            className="flex flex-col gap-3 rounded-card border border-line bg-white p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <h3 className="min-w-0 text-[15px] font-semibold leading-6 text-ink-900">
                {activity.title || '未命名活动'}
              </h3>
              {activity.badge && (
                <span className="h-5 shrink-0 rounded-[4px] bg-brand-yellow-soft px-1.5 text-[11px] font-medium leading-5 text-brand-yellow">
                  {activity.badge}
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
                {formatPoints(activity.points)}
              </span>
              <span className="text-xs leading-5 text-ink-700">算力值</span>
            </p>

            {summary.length > 0 && (
              <ul className="flex flex-col gap-1.5">
                {summary.map((line, index) => (
                  <li key={`${index}-${line}`} className="flex items-start gap-1.5 text-xs leading-5 text-ink-700">
                    <IconCheck />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}

            <button
              type="button"
              disabled
              tabIndex={-1}
              aria-label={`${activity.ctaLabel ?? '立即领取'}（预览，不可点击）`}
              className="mt-auto h-9 w-full cursor-default rounded-control bg-brand-orange text-[13px] font-medium text-white opacity-90"
            >
              {activity.ctaLabel ?? '立即领取'}
            </button>
          </article>
        );
      })}
    </div>
  );
}
