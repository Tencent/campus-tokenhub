/**
 * 侧边栏高亮的渲染结果：任一页面至多一个入口带 `aria-current="page"`。
 *
 * 回归背景：`/members` 与 `/members/review` 是父子入口，原先靠「`/members` 精确匹配」
 * 的特判压住双高亮。现在改由 `resolveActiveHref` 按深度收敛为唯一 href，
 * 这里从渲染结果守住这条约束（换实现也不该回退）。
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
      isAdmin: true,
      isMemberAdmin: true,
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
  it('成员审核页只高亮「成员审核」，不同时高亮父级「成员账号」', async () => {
    expect(activeHrefs(await render('/members/review'))).toEqual(['/members/review']);
  });

  it('成员账号页只高亮「成员账号」', async () => {
    expect(activeHrefs(await render('/members'))).toEqual(['/members']);
  });

  it('平级的管理员与系统设置各自独占高亮', async () => {
    expect(activeHrefs(await render('/admins'))).toEqual(['/admins']);
    expect(activeHrefs(await render('/settings'))).toEqual(['/settings']);
  });

  it('不属于任何入口的页面不高亮', async () => {
    expect(activeHrefs(await render('/login'))).toEqual([]);
  });
});
