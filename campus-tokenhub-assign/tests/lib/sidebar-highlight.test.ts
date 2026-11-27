/**
 * 侧边栏高亮的渲染结果：任一页面至多一个入口带 `aria-current="page"`。
 *
 * 回归背景：`/settings` 与 `/settings/admins` 是父子入口，单项前缀匹配会让
 * 「系统设置」与「管理员」在名单页同时高亮。选中态现在由 `resolveActiveHref`
 * 收敛为唯一 href，这里从渲染结果守住这条约束。
 */
import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const state = vi.hoisted(() => ({ path: '/' }));

vi.mock('next/navigation', () => ({ usePathname: () => state.path }));

// Link 只保留 href / aria-current 等属性输出；useLinkStatus 恒为已提交，隔离 pending 逻辑
vi.mock('next/link', async () => {
  const React = await import('react');
  const Link = (props: Record<string, unknown>) => {
    const { href, children, prefetch: _prefetch, ...rest } = props;
    return React.createElement('a', { href, ...rest }, children as never);
  };
  return { default: Link, useLinkStatus: () => ({ pending: false }) };
});

async function render(pathname: string): Promise<string> {
  state.path = pathname;
  const { Sidebar } = await import('@/components/portal/Sidebar');
  return renderToStaticMarkup(
    createElement(Sidebar as never, {
      adminBase: 'http://admin.test',
      isAdmin: true,
      showSetup: true,
      showSettings: true,
      schoolName: '演示学校',
      userName: 'Luca',
      userSub: 'luca@test',
    } as never),
  );
}

function activeHrefs(html: string): string[] {
  return [...html.matchAll(/<a href="([^"]+)" aria-current="page"/g)].map((match) => match[1]);
}

describe('侧边栏选中态唯一', () => {
  it('管理员名单页只高亮「管理员」，不同时高亮父级「系统设置」', async () => {
    expect(activeHrefs(await render('/settings/admins'))).toEqual(['/settings/admins']);
  });

  it('系统设置页只高亮「系统设置」', async () => {
    expect(activeHrefs(await render('/settings'))).toEqual(['/settings']);
  });

  it('系统设置的未知子页由「系统设置」兜底高亮', async () => {
    expect(activeHrefs(await render('/settings/branding'))).toEqual(['/settings']);
  });

  it('不属于任何入口的页面不高亮', async () => {
    expect(activeHrefs(await render('/playground'))).toEqual([]);
  });
});
