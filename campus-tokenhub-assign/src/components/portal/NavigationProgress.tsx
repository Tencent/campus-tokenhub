'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { usePathname } from 'next/navigation';

/**
 * 顶部导航进度条。
 *
 * App Router 没有暴露路由事件，这里用「document 上的内部链接点击 + pathname 变化」近似：
 * - 点击开始（capture 阶段，早于 Next 自己的处理），给用户即时反馈；
 * - pathname 变化即完成；
 * - 10 秒兜底，避免导航异常时进度条一直挂着。
 *
 * 只处理真正换页的导航：同 pathname 只改 query（时间区间、分页、筛选）不会触发
 * pathname 变化，进度条等不到完成信号，只能挂到 10 秒兜底，看起来像卡住。
 * 这类就地刷新应该由各自组件用 useLinkStatus 做局部提示。
 *
 * 只做 2px 的 transform 动画，不触发重排；reduced-motion 下换成静态显示。
 */

const SAFETY_MS = 10_000;
const DONE_MS = 220;

type Phase = 'idle' | 'running' | 'done';

function clearTimer(ref: MutableRefObject<number | null>): void {
  if (ref.current !== null) {
    window.clearTimeout(ref.current);
    ref.current = null;
  }
}

function isInternalNavigation(anchor: HTMLAnchorElement): boolean {
  if (anchor.target && anchor.target !== '_self') return false;
  if (anchor.hasAttribute('download')) return false;
  const href = anchor.getAttribute('href');
  if (!href || href.startsWith('#')) return false;

  let url: URL;
  try {
    url = new URL(anchor.href, window.location.href);
  } catch {
    return false;
  }
  if (url.origin !== window.location.origin) return false;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // 同 pathname 只换 query 属于就地刷新，不会引起 pathname 变化，交给页面内局部 loading
  if (url.pathname === window.location.pathname) return false;
  return true;
}

export function NavigationProgress() {
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>('idle');
  const runningRef = useRef(false);
  const safetyTimer = useRef<number | null>(null);
  const doneTimer = useRef<number | null>(null);

  const finish = useCallback((): void => {
    if (!runningRef.current) return;
    runningRef.current = false;
    clearTimer(safetyTimer);
    setPhase('done');
    clearTimer(doneTimer);
    doneTimer.current = window.setTimeout(() => setPhase('idle'), DONE_MS);
  }, []);

  const start = useCallback((): void => {
    clearTimer(doneTimer);
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase('running');
    clearTimer(safetyTimer);
    safetyTimer.current = window.setTimeout(finish, SAFETY_MS);
  }, [finish]);

  useEffect(() => {
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      const anchor = target instanceof Element ? target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      if (!isInternalNavigation(anchor)) return;
      start();
    };

    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', start);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', start);
    };
  }, [start]);

  const previousPath = useRef(pathname);
  useEffect(() => {
    if (previousPath.current === pathname) return;
    previousPath.current = pathname;
    finish();
  }, [pathname, finish]);

  useEffect(() => {
    return () => {
      clearTimer(safetyTimer);
      clearTimer(doneTimer);
    };
  }, []);

  return (
    <div
      aria-hidden
      className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 transition-opacity duration-150 ${
        phase === 'idle' ? 'opacity-0' : 'opacity-100'
      }`}
    >
      <div
        className={`h-full origin-left bg-brand-orange ${
          phase === 'idle' ? 'scale-x-0' : phase === 'running' ? 'nav-progress-running' : 'nav-progress-done'
        }`}
      />
    </div>
  );
}
