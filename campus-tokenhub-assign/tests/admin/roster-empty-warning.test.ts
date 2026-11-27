import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRosterEmpty, rosterNoticeContent, rosterNoticeKind } from '@/lib/admin/roster-notice';
import { RosterEmptyNotice } from '@/components/admin/RosterEmptyNotice';

describe('isRosterEmpty', () => {
  it('空数组视为空', () => {
    expect(isRosterEmpty([])).toBe(true);
  });

  it('只有引导期账号（local:）仍视为空', () => {
    expect(isRosterEmpty(['local:ops-admin'])).toBe(true);
    expect(isRosterEmpty(['LOCAL:ops-admin', 'local:other'])).toBe(true);
  });

  it('有真实 SSO 身份时不为空', () => {
    expect(isRosterEmpty(['100315:17915'])).toBe(false);
    expect(isRosterEmpty(['local:ops-admin', '100315:17915'])).toBe(false);
  });
});

describe('rosterNoticeKind', () => {
  it('名单为空时提示 empty', () => {
    expect(rosterNoticeKind([], false)).toBe('empty');
  });

  it('名单非空时无提示', () => {
    expect(rosterNoticeKind(['100315:17915'], false)).toBeNull();
  });

  it('读不到名单时优先提示 degraded', () => {
    expect(rosterNoticeKind([], true)).toBe('degraded');
    expect(rosterNoticeKind(['100315:17915'], true)).toBe('degraded');
  });
});

describe('rosterNoticeContent', () => {
  it('空名单文案说明首登认领风险', () => {
    expect(rosterNoticeContent('empty').title).toContain('认领');
    expect(rosterNoticeContent('empty').body).toContain('全局管理员');
  });

  it('读不到名单的文案与空名单不同', () => {
    expect(rosterNoticeContent('degraded').title).not.toBe(rosterNoticeContent('empty').title);
  });
});

describe('RosterEmptyNotice', () => {
  it('渲染为 role=alert 并带关键文案', () => {
    const html = renderToStaticMarkup(createElement(RosterEmptyNotice, { kind: 'empty' }));

    expect(html).toContain('role="alert"');
    expect(html).toContain('认领');
  });

  it('degraded 渲染读不到名单的文案', () => {
    const html = renderToStaticMarkup(createElement(RosterEmptyNotice, { kind: 'degraded' }));

    expect(html).toContain('role="alert"');
    expect(html).toContain('读不到管理员名单');
  });
});
