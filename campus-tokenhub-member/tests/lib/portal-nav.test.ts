import { describe, expect, it } from 'vitest';
import { buildNav, isNavItemActive, resolveActiveHref } from '@/lib/portal/nav';

const BASE = { isAdmin: false, isMemberAdmin: false, showSettings: false } as const;

describe('成员站导航（单模式）', () => {
  it('普通用户只有「成员账号」一个入口', () => {
    const nav = buildNav({ ...BASE });

    expect(nav.user.map((item) => item.label)).toEqual(['成员账号']);
    expect(nav.admin).toEqual([]);
  });

  it('审核管理员看到成员审核', () => {
    const nav = buildNav({ ...BASE, isMemberAdmin: true });

    expect(nav.admin.map((item) => item.label)).toEqual(['成员审核']);
  });

  it('全局管理员看到审核、管理员名单与系统设置，顺序固定', () => {
    const nav = buildNav({ isAdmin: true, isMemberAdmin: true, showSettings: true });

    expect(nav.admin.map((item) => item.label)).toEqual(['成员审核', '管理员', '系统设置']);
    expect(nav.admin.map((item) => item.href)).toEqual([
      '/members/review',
      '/admins',
      '/settings',
    ]);
  });

  it('没有算力、模型集市、看板、接入指南等网关侧入口', () => {
    const nav = buildNav({ isAdmin: true, isMemberAdmin: true, showSettings: true });
    const all = [...nav.user, ...nav.admin].map((item) => item.href);

    for (const gone of ['/overview', '/models', '/dashboard', '/guide', '/playground', '/setup']) {
      expect(all).not.toContain(gone);
    }
  });

  it('单项判定按路径段前缀命中：/members/review 也会命中 /members', () => {
    expect(isNavItemActive('/members', '/members')).toBe(true);
    expect(isNavItemActive('/members/review', '/members')).toBe(true);
    expect(isNavItemActive('/members/review', '/members/review')).toBe(true);
    expect(isNavItemActive('/admins', '/admins')).toBe(true);
    expect(isNavItemActive('/members-archive', '/members')).toBe(false);
  });
});

describe('侧边栏高亮唯一性（父子入口不同时选中）', () => {
  const ADMIN_HREFS = ['/members', '/members/review', '/admins', '/settings'];

  it('成员审核页只高亮「成员审核」，「成员账号」不再同亮', () => {
    expect(resolveActiveHref('/members/review', ADMIN_HREFS)).toBe('/members/review');
  });

  it('成员账号页只高亮「成员账号」', () => {
    expect(resolveActiveHref('/members', ADMIN_HREFS)).toBe('/members');
  });

  it('成员账号的其他子页仍由「成员账号」兜底高亮', () => {
    expect(resolveActiveHref('/members/detail', ADMIN_HREFS)).toBe('/members');
  });

  it('平级入口互不影响', () => {
    expect(resolveActiveHref('/admins', ADMIN_HREFS)).toBe('/admins');
    expect(resolveActiveHref('/settings', ADMIN_HREFS)).toBe('/settings');
  });

  it('带 query 的 href 不因字符串更长而抢走高亮', () => {
    const hrefs = ['/members', '/members/review?tab=pending'];
    expect(resolveActiveHref('/members/review', hrefs)).toBe('/members/review?tab=pending');
  });

  it('没有命中项时返回 null，站外链接不参与', () => {
    expect(resolveActiveHref('/login', ADMIN_HREFS)).toBeNull();
    expect(resolveActiveHref('/admins', ['http://admin.test'])).toBeNull();
  });

  it('整份导航里任一页面最多一个入口命中', () => {
    const nav = buildNav({ isAdmin: true, isMemberAdmin: true, showSettings: true });
    const hrefs = [...nav.user, ...nav.admin].filter((item) => !item.external).map((item) => item.href);

    for (const href of hrefs) {
      expect(resolveActiveHref(href, hrefs)).toBe(href);
      expect(hrefs.filter((candidate) => isNavItemActive(href, candidate)).length).toBeGreaterThanOrEqual(1);
    }
  });
});
