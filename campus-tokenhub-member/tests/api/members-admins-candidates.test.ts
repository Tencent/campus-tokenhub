import { beforeEach, describe, expect, it } from 'vitest';
import { setAdminRosterRepoOverride } from '@/lib/admin/roster';
import { memberRequest, resetMembersEnv } from '../helpers/members';
import { GET } from '@/app/api/portal/admins/candidates/route';

const ADMIN_SUB = '7:1';
const URL_BASE = 'http://portal.test/api/portal/admins/candidates';

/** 内存版共享名单：判权走 resolvePortalAdmin → readAdminSubs */
function rosterRepo(subs: string[]) {
  let list = [...subs];
  return {
    async list() {
      return [...list];
    },
    async replaceAll(next: string[]) {
      list = [...next];
    },
    async add(entries: string[]) {
      for (const entry of entries) if (!list.includes(entry)) list.push(entry);
    },
    async remove(sub: string) {
      list = list.filter((item) => item !== sub);
    },
  };
}

beforeEach(() => {
  resetMembersEnv();
  setAdminRosterRepoOverride(rosterRepo([ADMIN_SUB]));
});

describe('GET /api/portal/admins/candidates', () => {
  it('管理员能拿到候选，响应禁止缓存', async () => {
    const response = await GET(await memberRequest(URL_BASE, { method: 'GET', sub: ADMIN_SUB }));
    const body = (await response.json()) as { candidates?: { sub: string }[] };

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(body.candidates?.some((item) => item.sub === ADMIN_SUB)).toBe(true);
  });

  it('非管理员返回 403（候选是全校园联系人，不能放开）', async () => {
    const response = await GET(await memberRequest(URL_BASE, { method: 'GET', sub: '7:9999' }));

    expect(response.status).toBe(403);
  });

  it('关键字过长时截断，不会把整段文本带进查询', async () => {
    const long = 'a'.repeat(200);
    const response = await GET(
      await memberRequest(`${URL_BASE}?q=${encodeURIComponent(long)}`, {
        method: 'GET',
        sub: ADMIN_SUB,
      })
    );

    // 截断后照常返回（候选可能为空），不应 400/500
    expect(response.status).toBe(200);
  });
});
