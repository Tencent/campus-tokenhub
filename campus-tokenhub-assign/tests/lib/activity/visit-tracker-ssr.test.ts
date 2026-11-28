import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

/**
 * G1 回归：`VisitTracker` 挂在 (portal)/layout 上，是全站服务端布局。
 * 一旦它在没有浏览器能力的环境里抛错，/overview、/models、/dashboard 会全部白屏。
 * 这里用真实 SSR 渲染锁住「不抛错、不发上报」两条行为，不绑定实现细节。
 */

vi.mock('next/navigation', () => ({ usePathname: () => '/overview' }));

import { VisitTracker } from '@/components/portal/VisitTracker';

describe('VisitTracker 服务端渲染回归（G1）', () => {
  it('没有 window 时不抛错、不发起上报', () => {
    // 前置条件自检：node 环境里确实没有 window
    expect(typeof window).toBe('undefined');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const html = renderToString(
      createElement(VisitTracker, { endpoint: '/api/portal/activity/visit' })
    );

    // 组件不渲染任何节点，页面结构不受影响
    expect(html).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('endpoint 缺失也不抛错（服务端下发失误时的兜底）', () => {
    expect(() =>
      renderToString(createElement(VisitTracker, { endpoint: '' }))
    ).not.toThrow();
  });
});
