import { describe, expect, it } from 'vitest';
import { loginReuseTarget } from '@/lib/auth/login';

/**
 * 登录态复用：已登录的人访问 /login 时被直接弹走，落点由 next 决定。
 * 这里锁住「允许的落点」与「必须回落的两个自环 / 非页面目标」。
 */
describe('loginReuseTarget', () => {
  it('沿用站内 next（含 query 与片段）', () => {
    expect(loginReuseTarget('/members/review?page=2', '/members')).toBe('/members/review?page=2');
    expect(loginReuseTarget('/settings#auth', '/members')).toBe('/settings#auth');
  });

  it('没有 next 时回落到默认首页', () => {
    expect(loginReuseTarget(null, '/members')).toBe('/members');
    expect(loginReuseTarget(undefined, '/members')).toBe('/members');
    expect(loginReuseTarget('', '/members')).toBe('/members');
  });

  it.each([['/login'], ['/login?next=/members'], ['/login/'], ['/api/auth/logout'], ['/api/portal/members']])(
    '目标 %s 会把页面导航进死路，一律回落默认首页',
    (raw) => {
      expect(loginReuseTarget(raw, '/members')).toBe('/members');
    }
  );

  it.each([['//evil.example/x'], ['https://evil.example'], ['/\\evil.example'], ['/a\u0000b']])(
    '站外或畸形目标 %s 回落默认首页',
    (raw) => {
      expect(loginReuseTarget(raw, '/members')).toBe('/members');
    }
  );
});
