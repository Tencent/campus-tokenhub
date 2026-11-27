'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * 看板「换时间区间」的就地刷新状态。
 *
 * 换区间只是同路由换 query，服务端要重新取数，这段等待里页面还是旧数据。
 * 如果高亮完全由服务端给的 active 决定，点击后到数据落地之前界面毫无变化，
 * 看起来就像没点中。所以点击时先把目标区间记成 pendingRange：
 * - 高亮立刻切到 pendingRange（点中就选中）；
 * - isPending 期间图表区盖 loading；
 * - 新数据落地（服务端 activeRange 追上来）再释放，改回服务端状态。
 *
 * 导航本身仍交给 next/link 原生处理，这里只跟踪「点击 → 数据落地」这段过程。
 */

/** 导航异常（请求失败 / 被新的点击打断）时的兜底：别让高亮一直停在没落地的区间上 */
const SAFETY_MS = 15_000;

type RangeNavState = {
  /** 正在等新数据：选中项已乐观切换，页面内容仍是旧数据 */
  isPending: boolean;
  /** 刚点中、数据还没落地的区间 key */
  pendingRange: string | null;
  /** 点击区间项时调用，先切高亮再等数据 */
  markPending: (range: string) => void;
};

const NOOP: RangeNavState = { isPending: false, pendingRange: null, markPending: () => {} };

const RangeNavContext = createContext<RangeNavState>(NOOP);

export function RangeNavProvider({ activeRange, children }: { activeRange: string; children: ReactNode }) {
  const [pendingRange, setPendingRange] = useState<string | null>(null);

  const markPending = useCallback((range: string) => {
    setPendingRange((prev) => (prev === range ? prev : range));
  }, []);

  // 服务端 activeRange 变成刚点中的区间 = 新数据已提交，乐观状态交给服务端
  useEffect(() => {
    setPendingRange((prev) => (prev !== null && prev === activeRange ? null : prev));
  }, [activeRange]);

  useEffect(() => {
    if (pendingRange === null) return;
    const timer = window.setTimeout(() => setPendingRange(null), SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingRange]);

  const value = useMemo(
    () => ({ isPending: pendingRange !== null, pendingRange, markPending }),
    [pendingRange, markPending]
  );

  return <RangeNavContext.Provider value={value}>{children}</RangeNavContext.Provider>;
}

export function useRangeNav(): RangeNavState {
  return useContext(RangeNavContext);
}

/**
 * 图表区 loading：旧曲线蒙一层浅色遮罩 + 居中「正在加载」提示，
 * 新数据提交后自动恢复，避免切换区间时图看起来一动不动。
 *
 * 注意不要给 children 外面再加一层容器：图表用 `h-full` 撑满 flex 项，
 * 多一层百分比高度会掉成 auto。遮罩走绝对定位，不参与布局。
 */
export function RangePendingVeil({ children, className = '' }: { children: ReactNode; className?: string }) {
  const { isPending } = useRangeNav();

  return (
    <div className={`relative ${className}`} aria-busy={isPending}>
      {children}
      {isPending && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-control bg-white/60">
          <span
            role="status"
            className="flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-xs text-ink-500 shadow-card"
          >
            <span
              aria-hidden
              className="inline-block h-3 w-3 animate-spin rounded-full border-[1.5px] border-ink-300 border-t-transparent"
            />
            正在加载新数据
          </span>
        </div>
      )}
    </div>
  );
}
