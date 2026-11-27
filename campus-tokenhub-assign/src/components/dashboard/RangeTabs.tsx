'use client';

import Link from 'next/link';
import { useRangeNav } from './range-nav';

/**
 * 时间区间切换。
 *
 * 本质是同路由换 query：点击后服务端要重新取数，等待期间页面还是旧数据。
 * 所以点击瞬间先把高亮切到目标区间、并在选中项上转圈，数据落地后再交回服务端状态，
 * 避免「点了没反应，像是没点中」。导航仍交给 Link 原生处理（保留右键 / 中键开新窗口）。
 */

/** 等待提示：固定占位，避免 pending 前后按钮宽度跳动 */
function PendingSpinner({ visible }: { visible: boolean }) {
  return (
    <span
      aria-hidden
      className={`ml-1 inline-block h-3 w-3 shrink-0 rounded-full border-[1.5px] border-current border-t-transparent ${
        visible ? 'animate-spin opacity-70' : 'opacity-0'
      }`}
    />
  );
}

export function RangeTabs({
  items,
}: {
  items: { key: string; label: string; href: string; active: boolean }[];
}) {
  const { isPending, pendingRange, markPending } = useRangeNav();

  return (
    <div className="flex items-center gap-1 rounded-control border border-line bg-white p-0.5">
      {items.map((item) => {
        // 刚点中的区间先高亮，等新数据提交后 pendingRange 释放，回到服务端 active
        const active = pendingRange ? item.key === pendingRange : item.active;
        const loading = isPending && item.key === pendingRange;

        return (
          <Link
            key={item.key}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            aria-busy={loading || undefined}
            onClick={(event) => {
              // 组合键是「新标签页打开」，当前页不会刷新，别把 loading 挂上去
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (active) return;
              markPending(item.key);
            }}
            className={`flex h-7 items-center rounded-[4px] px-2.5 text-xs transition ${
              active ? 'bg-brand-orange-soft font-medium text-brand-orange' : 'text-ink-700 hover:bg-cream-100'
            }`}
          >
            {item.label}
            <PendingSpinner visible={loading} />
          </Link>
        );
      })}
    </div>
  );
}
