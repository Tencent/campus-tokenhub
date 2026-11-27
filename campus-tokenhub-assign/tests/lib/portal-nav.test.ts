import { describe, expect, it } from 'vitest';
import { buildNav, isNavItemActive, resolveActiveHref } from '@/lib/portal/nav';

const BASE = {
  isAdmin: false,
  showSetup: false,
  showSettings: false,
  adminBase: null,
} as const;

describe('统一采买站导航（单模式）', () => {
  it('普通用户只有四个用户入口，没有管理入口', () => {
    const nav = buildNav({ ...BASE });

    expect(nav.user.map((item) => item.label)).toEqual([
      '我的算力',
      '模型集市',
      '数据看板',
      '接入指南',
    ]);
    expect(nav.admin).toEqual([]);
  });

  it('管理员看到初始化、运营活动、管理员名单、系统设置与网关后台，顺序固定', () => {
    const nav = buildNav({
      isAdmin: true,
      showSetup: true,
      showSettings: true,
      adminBase: 'http://admin.test',
    });

    expect(nav.admin.map((item) => item.label)).toEqual([
      '初始化',
      '运营活动',
      '管理员',
      '系统设置',
      '网关管理后台',
    ]);
  });

  it('管理员名单入口指向 /settings/admins，不再有成员相关入口', () => {
    const nav = buildNav({ ...BASE, isAdmin: true });

    expect(nav.admin.map((item) => item.href)).toEqual(['/activities', '/settings/admins']);
    expect(nav.admin.some((item) => item.href.includes('/members'))).toBe(false);
  });

  it('双站部署时用户入口追加「成员账号」外链，指向成员站 /members', () => {
    const nav = buildNav({ ...BASE, memberBase: 'https://ai.example.edu.cn/tokenhub/member/' });

    expect(nav.user.map((item) => item.label)).toEqual([
      '我的算力',
      '模型集市',
      '数据看板',
      '接入指南',
      '成员账号',
    ]);
    expect(nav.user.at(-1)).toEqual({
      href: 'https://ai.example.edu.cn/tokenhub/member/members',
      label: '成员账号',
      icon: 'members',
      external: true,
    });
  });

  it('单站部署（未配置成员站地址）时不显示成员账号入口', () => {
    const nav = buildNav({ ...BASE, memberBase: '' });

    expect(nav.user.some((item) => item.label === '成员账号')).toBe(false);
  });

  it('没有网关后台地址时不渲染外链', () => {
    const nav = buildNav({ ...BASE, isAdmin: true, adminBase: null });

    expect(nav.admin.some((item) => item.external)).toBe(false);
  });

  it('showSetup 是服务端算好的权限位，非管理员也能看到初始化入口', () => {
    const nav = buildNav({ ...BASE, isAdmin: false, showSetup: true, showSettings: true });

    // 设置入口额外要求 isAdmin；初始化只看 showSetup
    expect(nav.admin.map((item) => item.label)).toEqual(['初始化']);
  });

  it('active 判定按路径段前缀命中，站外链接不参与', () => {
    expect(isNavItemActive('/models/gpt-4', '/models')).toBe(true);
    expect(isNavItemActive('/models', '/models')).toBe(true);
    expect(isNavItemActive('/models-archive', '/models')).toBe(false);
    expect(isNavItemActive('/settings/admins', '/settings/admins')).toBe(true);
    expect(isNavItemActive('/settings', '/settings/admins')).toBe(false);
    expect(isNavItemActive('/overview', 'http://admin.test')).toBe(false);
  });
});

describe('侧边栏高亮唯一性（父子入口不同时选中）', () => {
  const ADMIN_HREFS = ['/overview', '/models', '/dashboard', '/guide', '/activities', '/settings/admins', '/settings'];

  it('在管理员名单页只高亮「管理员」，父级「系统设置」不再同亮', () => {
    // 单项判定两者都会命中，这是问题根源
    expect(isNavItemActive('/settings/admins', '/settings')).toBe(true);

    const active = resolveActiveHref('/settings/admins', ADMIN_HREFS);
    expect(active).toBe('/settings/admins');
  });

  it('在系统设置页只高亮「系统设置」', () => {
    expect(resolveActiveHref('/settings', ADMIN_HREFS)).toBe('/settings');
  });

  it('系统设置的其他子页仍由「系统设置」兜底高亮', () => {
    expect(resolveActiveHref('/settings/branding', ADMIN_HREFS)).toBe('/settings');
  });

  it('深层页面按最长 href 命中，不误伤同前缀的兄弟入口', () => {
    expect(resolveActiveHref('/models/gpt-4', ADMIN_HREFS)).toBe('/models');
    expect(resolveActiveHref('/models-archive', ADMIN_HREFS)).toBeNull();
  });

  it('带 query 的 href 不因字符串更长而抢走高亮', () => {
    const hrefs = ['/settings', '/settings/admins?tab=active'];
    expect(resolveActiveHref('/settings/admins', hrefs)).toBe('/settings/admins?tab=active');
    expect(resolveActiveHref('/settings', ['/settings?tab=1', '/settings/admins'])).toBe('/settings?tab=1');
  });

  it('没有命中项时返回 null，站外链接不参与', () => {
    expect(resolveActiveHref('/overview', ['/api/auth/admin-entry'])).toBeNull();
    expect(resolveActiveHref('/overview', ADMIN_HREFS)).toBe('/overview');
  });

  it('整份导航里任一页面最多一个入口命中', () => {
    const nav = buildNav({
      isAdmin: true,
      showSetup: true,
      showSettings: true,
      adminBase: 'http://admin.test',
    });
    const hrefs = [...nav.user, ...nav.admin].filter((item) => !item.external).map((item) => item.href);

    for (const href of hrefs) {
      const active = resolveActiveHref(href, hrefs);
      const hits = hrefs.filter((candidate) => isNavItemActive(href, candidate));
      expect(active).toBe(href);
      // 命中列表可能因为父子关系有多条，但解析结果必须唯一且等于当前路径
      expect(hits.length).toBeGreaterThanOrEqual(1);
    }
  });
});
