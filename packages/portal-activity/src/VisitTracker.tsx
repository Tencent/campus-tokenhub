'use client';

/**
 * 页面访问上报组件。
 *
 * 挂在 `(portal)/layout.tsx`：`usePathname()` 变化才上报，
 * 因此天然排除 Next 的 RSC 预取；同路径 1 秒内去重挡住重复渲染。
 *
 * `endpoint` 由服务端传入已带 basePath 的路径（`appPath()` 的结果），
 * 组件内不拼前缀——客户端组件读不到构建期的 basePath。
 */

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { planVisit, type VisitState } from './path';
import { reportVisit, type VisitTransport } from './transport';

export type VisitTrackerProps = {
  /** 已带部署前缀的上报地址 */
  endpoint: string;
  /** 测试或特殊环境注入的传输实现；默认用浏览器能力 */
  transport?: VisitTransport;
};

function browserTransport(): VisitTransport {
  const transport: VisitTransport = {};

  if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    transport.sendBeacon = (url, data) => navigator.sendBeacon(url, data);
  }
  if (typeof fetch === 'function') {
    transport.fetch = (input, init) => fetch(input, init);
  }

  return transport;
}

export function VisitTracker({ endpoint, transport }: VisitTrackerProps): null {
  const pathname = usePathname();
  const lastVisit = useRef<VisitState>(null);

  useEffect(() => {
    // SSR / 静态渲染阶段没有 window，直接跳过
    if (typeof window === 'undefined') return;

    // 去重决策在纯函数里做（`planVisit`），effect 只负责触发与记录
    const plan = planVisit(lastVisit.current, pathname, Date.now());
    if (!plan.report) return;

    lastVisit.current = { path: plan.path, at: plan.at };
    reportVisit(endpoint, plan.path, transport ?? browserTransport());
  }, [pathname, endpoint, transport]);

  return null;
}
