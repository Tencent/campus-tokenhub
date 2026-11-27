'use client';

import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { POINTS_PER_YUAN } from '@/lib/portal/points';
import { formatTokens } from '@/lib/portal/usage-format';
import { ChartTooltip } from './ChartTooltip';

/** 趋势点：value 是网关金额（元），提示框里统一折算成算力值展示 */
export type TrendChartPoint = {
  label: string;
  value: number;
  /** 未按模型/密钥筛选时附带的明细，用于提示框展示更多口径 */
  requests?: number;
  tokens?: number;
};

const WIDTH = 720;
const HEIGHT = 240;
const PAD_TOP = 16;
const PAD_BOTTOM = 8;

/** 算力值：大数取整，小数留 1 位，避免单日消耗很小时全变成 0 */
function formatPointsValue(yuan: number): string {
  const points = yuan * POINTS_PER_YUAN;
  if (!Number.isFinite(points)) return '0';
  if (Math.abs(points) >= 10) return Math.round(points).toLocaleString('zh-CN');
  return (Math.round(points * 10) / 10).toLocaleString('zh-CN');
}

/** 消耗趋势：折线 + 面积，只有横向网格线，不带坐标轴标签（对齐设计稿） */
export function UsageTrendChart({
  points,
  className = 'h-full',
}: {
  points: TrendChartPoint[];
  className?: string;
}) {
  const count = points.length;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const active = activeIndex !== null && activeIndex >= 0 && activeIndex < count ? activeIndex : null;

  const handlePointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0 || count === 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const nearest = count > 1 ? Math.round(ratio * (count - 1)) : 0;
      setActiveIndex(Math.min(count - 1, Math.max(0, nearest)));
    },
    [count]
  );

  if (count === 0) {
    return <div className={`w-full rounded-control bg-cream/50 ${className}`} />;
  }

  const peak = Math.max(...points.map((item) => Math.max(0, item.value)), 1);
  const usable = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const step = count > 1 ? WIDTH / (count - 1) : WIDTH;
  const xOf = (index: number): number => (count > 1 ? index * step : WIDTH / 2);
  const yOf = (value: number): number => PAD_TOP + usable - (Math.max(0, value) / peak) * usable;

  const coords = points.map((item, index) => [xOf(index), yOf(item.value)] as const);
  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`;

  const activePoint = active === null ? null : points[active];
  const activeXPercent = active === null ? 0 : (xOf(active) / WIDTH) * 100;
  const activeYPercent = active === null ? 0 : (yOf(points[active].value) / HEIGHT) * 100;
  /** 点靠下时提示框向上展开，靠上时向下展开；左右同理，避免溢出卡片 */
  const tooltipTransform = `translate(${activeXPercent > 55 ? 'calc(-100% - 8px)' : '8px'}, ${
    activeYPercent >= 45 ? 'calc(-100% - 8px)' : '8px'
  })`;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setActiveIndex(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const stepDirection = event.key === 'ArrowRight' ? 1 : -1;
    setActiveIndex((previous) => {
      const base = previous === null ? (stepDirection > 0 ? -1 : count) : previous;
      return Math.min(count - 1, Math.max(0, base + stepDirection));
    });
  };

  return (
    <div className={`relative w-full ${className}`}>
      <div
        className="absolute inset-0 cursor-crosshair rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/30"
        tabIndex={0}
        role="group"
        aria-label="消耗趋势折线图，可悬停或按左右方向键查看每天的具体数值"
        onPointerMove={handlePointer}
        onPointerDown={handlePointer}
        onPointerLeave={() => setActiveIndex(null)}
        onBlur={() => setActiveIndex(null)}
        onKeyDown={handleKeyDown}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role="img"
          aria-label="消耗趋势折线图"
        >
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
            <line
              key={ratio}
              x1={0}
              x2={WIDTH}
              y1={PAD_TOP + usable * ratio}
              y2={PAD_TOP + usable * ratio}
              stroke="#EDEFF3"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <path d={area} fill="rgba(37, 87, 214, 0.08)" />
          <path d={line} fill="none" stroke="#2557D6" strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
        </svg>

        {active !== null && (
          <>
            <span
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-ink-300"
              style={{ left: `${activeXPercent}%` }}
              aria-hidden
            />
            <span
              className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-[#2557D6]"
              style={{ left: `${activeXPercent}%`, top: `${activeYPercent}%` }}
              aria-hidden
            />
          </>
        )}
      </div>

      {activePoint && (
        <ChartTooltip
          className="min-w-[8rem] max-w-[12rem]"
          style={{ left: `${activeXPercent}%`, top: `${activeYPercent}%`, transform: tooltipTransform }}
        >
          <p className="flex items-baseline justify-between gap-2 text-[10px] text-ink-500 tabular-nums">
            <span className="font-medium text-ink-700">{activePoint.label}</span>
            <span>算力值</span>
          </p>
          <p className="mt-0.5 text-[13px] font-semibold leading-5 text-ink-900 tabular-nums">
            {formatPointsValue(activePoint.value)}
          </p>
          {(activePoint.requests !== undefined || activePoint.tokens !== undefined) && (
            <dl className="mt-1 space-y-0.5 border-t border-line/70 pt-1 text-[10px] text-ink-500 tabular-nums">
              {activePoint.requests !== undefined && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt>调用次数</dt>
                  <dd className="font-medium text-ink-700">{activePoint.requests.toLocaleString('zh-CN')} 次</dd>
                </div>
              )}
              {activePoint.tokens !== undefined && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt>Token</dt>
                  <dd className="font-medium text-ink-700">{formatTokens(activePoint.tokens)}</dd>
                </div>
              )}
            </dl>
          )}
        </ChartTooltip>
      )}
    </div>
  );
}
