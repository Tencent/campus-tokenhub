import type { CSSProperties, ReactNode } from 'react';

/**
 * 图表悬停提示框的外壳：三张图（趋势 / 环形 / 时段）共用一套视觉。
 *
 * 只负责样式和层级，定位由调用方通过 style / className 决定，
 * 因为各图的坐标系（百分比、像素）不一样。
 */
export function ChartTooltip({
  children,
  className = '',
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`pointer-events-none absolute z-10 rounded-md border border-line bg-white/95 px-2.5 py-2 text-[11px] leading-4 shadow-pop ${className}`}
      style={style}
    >
      {children}
    </div>
  );
}
