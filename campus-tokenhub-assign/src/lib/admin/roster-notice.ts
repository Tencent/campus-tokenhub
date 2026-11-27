/**
 * 管理员名单为空的风险提示判定。
 *
 * 名单为空时 `claimFirstAdmin` 会把下一个完成 SSO 登录的人认领为全局管理员
 * （见 `lib/admin/roster.ts`）。认领本身有 advisory lock + 事务内 count，并发是安全的，
 * 风险在触发条件：全新部署或被清空名单后，第一个登录的人（可能是学生）就拿到最高权限。
 *
 * 部署方确认「首个登录的一定是部署老师」，因此这里只做**提示**，不改认领逻辑。
 */

export type RosterNoticeKind = 'empty' | 'degraded';

export type RosterNoticeContent = { title: string; body: string };

/** `local:` 前缀是引导期账号，不代表「已有真实管理员」 */
export function isRosterEmpty(subs: readonly string[]): boolean {
  return !subs.some((sub) => !sub.toLowerCase().startsWith('local:'));
}

/** 名单读不到（degraded）优先单独提示，避免与「确实为空」混为一谈 */
export function rosterNoticeKind(subs: readonly string[], degraded: boolean): RosterNoticeKind | null {
  if (degraded) return 'degraded';
  return isRosterEmpty(subs) ? 'empty' : null;
}

export function rosterNoticeContent(kind: RosterNoticeKind): RosterNoticeContent {
  if (kind === 'degraded') {
    return {
      title: '暂时读不到管理员名单',
      body: '数据库连接异常时无法判断名单是否为空，请检查 PORTAL_DATABASE_URL 与服务状态后刷新。此时已有会话仍可继续使用。',
    };
  }
  return {
    title: '管理员名单为空：下一个登录的人会被认领为全局管理员',
    body: '名单里没有真实管理员时，第一个完成 SSO 登录的人会自动成为全局管理员（可改设置、发 Key、改供应商密钥）。请先在这里把管理员加全，再对外开放访问。',
  };
}
