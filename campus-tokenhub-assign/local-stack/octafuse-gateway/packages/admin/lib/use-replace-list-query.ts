'use client';

/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import type { DependencyList } from 'react';
import { useEffect, useRef } from 'react';
import { usePathname, useRouter } from '@/ui/navigation';

/**
 * 列表页筛选变更时把当前条件写回 URL（`router.replace`，无滚动）。
 * 首次运行跳过，避免覆盖同轮挂载里「从 URL 读入 state」的 effect。
 */
export function useReplaceListPageQuery(buildParams: () => URLSearchParams, deps: DependencyList) {
  const router = useRouter();
  const pathname = usePathname();
  const skipWrite = useRef(true);

  useEffect(() => {
    if (skipWrite.current) {
      skipWrite.current = false;
      return;
    }
    const params = buildParams();
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, ...deps]);
}
