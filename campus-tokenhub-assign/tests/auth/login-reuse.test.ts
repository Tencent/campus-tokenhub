import { describe, expect, it } from 'vitest';
import { loginReuseTarget } from '@/lib/auth/login';

/**
 * 登录态复用：已登录的人访问 /login 时被直接弹走，落点由 next 决定。
 * 这里锁住「允许的落点」与「必须回落的两个自环 / 非页面目标」。
 */
describe('loginReuseTarget', () => {
  it('沿用站内 next（含 query 与片段）', () => {
    expect(loginReuseTarget('/overview?tab=keys', '/overview')).toBe('/overview?tab=keys');
    expect(loginReuseTarget('/settings#auth', '/overview')).toBe('/settings#auth');
  });

  it('没有 next 时回落到默认首页', () => {
    expect(loginReuseTarget(null, '/overview')).toBe('/overview');
    expect(loginReuseTarget(undefined, '/overview')).toBe('/overview');
    expect(loginReuseTarget('', '/overview')).toBe('/overview');
  });

  it.each([['/login'], ['/login?next=/overview'], ['/login/'], ['/api/auth/logout'], ['/api/portal/keys']])(
    '目标 %s 会把页面导航进死路，一律回落默认首页',
    (raw) => {
      expect(loginReuseTarget(raw, '/overview')).toBe('/overview');
    }
  );

  it.each([['//evil.example/x'], ['https://evil.example'], ['/\\evil.example'], ['/a\u0000b']])(
    '站外或畸形目标 %s 回落默认首页',
    (raw) => {
      expect(loginReuseTarget(raw, '/overview')).toBe('/overview');
    }
  );
});
