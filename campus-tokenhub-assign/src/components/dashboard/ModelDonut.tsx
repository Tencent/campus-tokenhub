'use client';

import { useState } from 'react';
import { formatPointsFromYuan } from '@/lib/portal/points';

/** 模型使用分布：环形图 + 图例百分比；最多展示 3 个模型，其余合并为「其他」 */
const COLORS = ['#2557D6', '#4C79E0', '#8AA7EC', '#C3D2F4'];

/** points = 按算力值占比，requests = 全零消耗时退化为调用次数占比 */
export type DonutMetric = 'points' | 'requests';

export type DonutItem = { name: string; value: number };

type Segment = { name: string; value: number; share: number; color: string };

function buildSegments(items: DonutItem[]): Segment[] {
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];

  const sorted = [...items].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, 3);
  const rest = sorted.slice(3);
  const restValue = rest.reduce((sum, item) => sum + item.value, 0);

  const segments = head.map((item, index) => ({
    name: item.name,
    value: item.value,
    share: item.value / total,
    color: COLORS[index] ?? COLORS[COLORS.length - 1],
  }));

  if (restValue > 0) {
    segments.push({
      name: `其他 ${rest.length} 个模型`,
      value: restValue,
      share: restValue / total,
      color: COLORS[3],
    });
  }

  return segments;
}

/** 占比文案：大切片取整，小切片保留 1 位，避免出现一片「0%」 */
function formatShare(share: number): string {
  const percent = share * 100;
  return `${percent >= 10 ? Math.round(percent) : percent.toFixed(1)}%`;
}

function formatMetric(value: number, metric: DonutMetric): string {
  if (metric === 'points') return `${formatPointsFromYuan(value)} 算力值`;
  return `${Math.round(value).toLocaleString('zh-CN')} 次`;
}

export function ModelDonut({ items, metric = 'points' }: { items: DonutItem[]; metric?: DonutMetric }) {
  const segments = buildSegments(items);
  /** 悬停高亮：环上切片与图例共用同一份状态，两边都能触发 */
  const [activeName, setActiveName] = useState<string | null>(null);

  if (segments.length === 0) {
    return (
      <div className="flex h-[180px] items-center justify-center rounded-control bg-cream/50 text-xs text-ink-500">
        这段时间还没有调用记录
      </div>
    );
  }

  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const active = segments.find((segment) => segment.name === activeName) ?? null;
  let offset = 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-center">
        <div className="relative h-[160px] w-[160px]">
          <svg
            width="160"
            height="160"
            viewBox="0 0 160 160"
            className="h-full w-full"
            role="img"
            aria-label={`模型使用分布环形图，按${metric === 'points' ? '算力值' : '调用次数'}占比`}
            onPointerLeave={() => setActiveName(null)}
          >
            <g transform="rotate(-90 80 80)">
              {segments.map((segment) => {
                const length = segment.share * circumference;
                const dash = `${Math.max(length - 2, 0)} ${circumference - Math.max(length - 2, 0)}`;
                const isActive = active?.name === segment.name;
                const element = (
                  <circle
                    key={segment.name}
                    cx="80"
                    cy="80"
                    r={radius}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={isActive ? 30 : 26}
                    strokeDasharray={dash}
                    strokeDashoffset={-offset}
                    opacity={active && !isActive ? 0.35 : 1}
                    style={{ transition: 'stroke-width 150ms ease, opacity 150ms ease' }}
                    onPointerEnter={() => setActiveName(segment.name)}
                  />
                );
                offset += length;
                return element;
              })}
            </g>
          </svg>

          {active && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[15px] font-semibold leading-5 text-ink-900 tabular-nums">
                {formatShare(active.share)}
              </span>
              <span
                className="mt-0.5 max-w-[78px] truncate text-[10px] leading-3 text-ink-500"
                title={active.name}
              >
                {active.name}
              </span>
              <span className="mt-1 text-[10px] font-medium leading-3 text-ink-700 tabular-nums">
                {formatMetric(active.value, metric)}
              </span>
            </div>
          )}
        </div>
      </div>

      <ul className="flex flex-col gap-2">
        {segments.map((segment) => {
          const isActive = active?.name === segment.name;
          return (
            <li
              key={segment.name}
              className={`flex cursor-default items-center gap-2 rounded-[4px] px-1 py-0.5 transition-colors ${
                isActive ? 'bg-cream-100' : ''
              }`}
              onPointerEnter={() => setActiveName(segment.name)}
              onPointerLeave={() => setActiveName(null)}
            >
              <span
                aria-hidden
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: segment.color }}
              />
              <span className="min-w-0 flex-1 truncate text-xs leading-5 text-ink-700">{segment.name}</span>
              <span className="shrink-0 text-xs leading-5 tabular-nums text-ink-500">
                {formatShare(segment.share)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
