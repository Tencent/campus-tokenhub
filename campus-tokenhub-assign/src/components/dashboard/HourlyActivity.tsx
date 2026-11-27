'use client';

import { useState, type KeyboardEvent, type PointerEvent } from 'react';
import { ChartTooltip } from './ChartTooltip';

/** 时段活跃：24 小时请求数柱状图，高亮最活跃的连续 3 小时 */
export type HourlyPoint = { hour: number; requests: number };

const WINDOW_SIZE = 3;

/** 找出请求数之和最大的连续 3 小时窗口 */
function busiestWindow(points: HourlyPoint[]): { start: number; end: number } | null {
  if (points.length === 0) return null;
  const max = Math.max(...points.map((item) => item.requests));
  if (max <= 0) return null;

  let bestStart = 0;
  let bestSum = -1;
  for (let start = 0; start + WINDOW_SIZE <= points.length; start += 1) {
    const sum = points.slice(start, start + WINDOW_SIZE).reduce((acc, item) => acc + item.requests, 0);
    if (sum > bestSum) {
      bestSum = sum;
      bestStart = start;
    }
  }
  return { start: bestStart, end: bestStart + WINDOW_SIZE };
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** 小切片保留 1 位小数，避免出现「占 0%」 */
function formatShare(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

type HoverState = {
  index: number;
  /** 指针坐标（相对图表容器）；键盘操作时为 null，走柱心百分比定位 */
  x: number | null;
  y: number | null;
  width: number;
};

export function HourlyActivity({ points }: { points: HourlyPoint[] }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const busiest = busiestWindow(points);
  const peak = Math.max(...points.map((item) => item.requests), 1);
  const total = points.reduce((sum, item) => sum + item.requests, 0);
  const count = points.length;

  const activeItem = hover === null ? null : points[hover.index] ?? null;
  const activeHeight =
    activeItem === null ? 0 : Math.max(2, Math.round((activeItem.requests / peak) * 100));
  const activeInBusiest =
    activeItem !== null && busiest !== null && activeItem.hour >= busiest.start && activeItem.hour < busiest.end;

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || count === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.min(count - 1, Math.max(0, Math.floor(ratio * count)));
    setHover({ index, x: event.clientX - rect.left, y: event.clientY - rect.top, width: rect.width });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      setHover(null);
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const stepDirection = event.key === 'ArrowRight' ? 1 : -1;
    setHover((previous) => {
      const base = previous === null ? (stepDirection > 0 ? -1 : count) : previous.index;
      const next = Math.min(count - 1, Math.max(0, base + stepDirection));
      return { index: next, x: null, y: null, width: 0 };
    });
  };

  const tooltipStyle = (() => {
    if (!hover) return undefined;
    /**
     * 指针操作跟随光标（左右翻转避免溢出），键盘操作贴住柱心；
     * 竖向优先放在光标上方，靠近顶部时改为下方。
     */
    if (hover.x === null || hover.y === null) {
      const ratio = count > 0 ? (hover.index + 0.5) / count : 0.5;
      return {
        left: `${Math.min(92, Math.max(8, ratio * 100))}%`,
        top: 4,
        transform: 'translateX(-50%)',
      };
    }
    const flipX = hover.x > hover.width / 2;
    /** 提示框只有一行（约 32px），贴光标上下放都能留在绘图区内，不会盖住 00:00 刻度 */
    const above = hover.y > 44;
    return {
      left: hover.x,
      top: hover.y,
      transform: `translate(${flipX ? 'calc(-100% - 12px)' : '12px'}, ${
        above ? 'calc(-100% - 12px)' : '12px'
      })`,
    };
  })();

  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-white p-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold leading-6 text-ink-900">时段活跃分析</h2>
        {busiest ? (
          <p className="text-xs leading-5 text-ink-500">
            你最活跃的时段：
            <span className="font-medium text-ink-900">
              {hourLabel(busiest.start)} – {hourLabel(busiest.end === 24 ? 23 : busiest.end)}
            </span>
          </p>
        ) : (
          <p className="text-xs leading-5 text-ink-500">这段时间还没有调用记录</p>
        )}
      </div>

      {total > 0 && (
        <div
          className="relative flex h-[100px] items-end gap-[3px] rounded-[4px] outline-none focus-visible:ring-2 focus-visible:ring-brand-orange/30"
          tabIndex={0}
          role="group"
          aria-label="时段活跃柱状图，可悬停或按左右方向键查看每个小时的调用次数"
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={handleKeyDown}
        >
          {points.map((item, index) => {
            const inBusiest = busiest !== null && item.hour >= busiest.start && item.hour < busiest.end;
            const hovered = hover?.index === index;
            const height = Math.max(2, Math.round((item.requests / peak) * 100));
            const color = hovered
              ? inBusiest
                ? '#1E48B8'
                : '#7C9FE0'
              : inBusiest
                ? '#2557D6'
                : '#C9D8F5';
            return (
              <div key={item.hour} className="flex-1">
                <div
                  className="w-full rounded-[2px] transition-colors"
                  style={{ height: `${height}px`, backgroundColor: color }}
                />
              </div>
            );
          })}

          {activeItem && tooltipStyle && (
            <ChartTooltip className="whitespace-nowrap" style={tooltipStyle}>
              <p className="text-[11px] leading-4 text-ink-700 tabular-nums">
                <span className="font-medium">
                  {hourLabel(activeItem.hour)} – {hourLabel((activeItem.hour + 1) % 24)}
                </span>
                <span className="mx-1.5 text-ink-300">·</span>
                <span className="font-semibold text-ink-900">
                  {activeItem.requests.toLocaleString('zh-CN')} 次
                </span>
                <span className="mx-1.5 text-ink-300">·</span>
                <span className="text-ink-500">占全部时段 {formatShare(activeItem.requests / total)}</span>
                {activeInBusiest ? <span className="ml-1.5 text-brand-orange">高峰</span> : null}
              </p>
            </ChartTooltip>
          )}

          {/* 键盘操作时按钮位置没有光标，用柱高给出一个视觉锚点 */}
          {activeItem && hover?.x === null && (
            <span
              className="pointer-events-none absolute bottom-0 w-full max-w-[8px] -translate-x-1/2 rounded-[2px] bg-brand-orange/20"
              style={{
                left: `${((hover.index + 0.5) / count) * 100}%`,
                height: `${activeHeight}px`,
              }}
              aria-hidden
            />
          )}
        </div>
      )}

      {total > 0 && (
        <div className="flex justify-between text-[11px] leading-4 text-ink-400">
          <span>00:00</span>
          <span>06:00</span>
          <span>12:00</span>
          <span>18:00</span>
          <span>23:00</span>
        </div>
      )}
    </section>
  );
}
