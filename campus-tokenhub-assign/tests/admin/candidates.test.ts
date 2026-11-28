import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { readAdminCandidates } from '@/lib/admin/candidates';
import type { AdminRosterRepo } from '@/lib/admin/roster';
import { fakeClient, wrap } from '../helpers/fake-client';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

beforeEach(() => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
});

afterEach(() => {
  resetConfigCache();
});

/** 内存名单：候选只关心 subs，写操作不需要实现 */
function memoryRepo(subs: string[]): AdminRosterRepo {
  return {
    async list() {
      return [...subs];
    },
    async replaceAll() {},
    async add() {},
    async remove() {},
  };
}

type FakeUser = {
  id: string;
  email: string;
  external_user_id: string;
  external_system: string;
};

function gatewayUser(sub: string, name: string): FakeUser {
  return {
    id: `id-${sub}`,
    email: `${name}.${sub.replace(':', '-')}@school.local`,
    external_user_id: sub,
    external_system: 'campus-tokenhub',
  };
}

/** 模拟网关用户列表：email 模糊匹配，external_user_id 精确匹配 */
function gateway(users: FakeUser[]) {
  return fakeClient((call) => {
    const query = (call.request?.query ?? {}) as { email?: string; external_user_id?: string };
    let matched = users;
    if (query.external_user_id) {
      matched = users.filter((user) => user.external_user_id === query.external_user_id);
    } else if (query.email) {
      matched = users.filter((user) => user.email.includes(query.email as string));
    }
    return wrap(matched, { total: matched.length, page: 1, page_size: 20 });
  });
}

/**
 * 模拟「最近一页」被截断：不带关键字时只回 `latestPage`，
 * 按 `external_user_id` 才回全量里的精确命中。
 */
function gatewayWithTruncatedPage(users: FakeUser[], latestPage: FakeUser[]) {
  return fakeClient((call) => {
    const query = (call.request?.query ?? {}) as { email?: string; external_user_id?: string };
    if (query.external_user_id) {
      const matched = users.filter((user) => user.external_user_id === query.external_user_id);
      return wrap(matched, { total: matched.length, page: 1, page_size: 20 });
    }
    if (query.email) {
      const matched = users.filter((user) => user.email.includes(query.email as string));
      return wrap(matched, { total: matched.length, page: 1, page_size: 20 });
    }
    return wrap(latestPage, { total: users.length, page: 1, page_size: 20 });
  });
}

describe('管理员候选（统一采买站）', () => {
  const zhang = gatewayUser('100051:1001', '张三');
  const li = gatewayUser('100051:1002', '李四');
  const wang = gatewayUser('100051:1003', '王五');

  it('未输入关键字时带上名单项与网关最近用户', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      repo: memoryRepo(['100051:1001', '100051:1002']),
      client: gateway([zhang, li, wang]),
    });

    expect(candidates.map((item) => item.sub).sort()).toEqual([
      '100051:1001',
      '100051:1002',
      '100051:1003',
    ]);
    expect(candidates.find((item) => item.sub === '100051:1003')?.listed).toBe(false);
  });

  it('搜索时只返回命中的用户，不再用名单项占满候选', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      query: '张',
      repo: memoryRepo(['100051:1001', '100051:1002']),
      client: gateway([zhang, li, wang]),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sub: '100051:1001',
      name: '张三',
      listed: true,
    });
  });

  it('搜索命中名单外账号时保留姓名并可添加', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      query: '王',
      repo: memoryRepo(['100051:1001']),
      client: gateway([zhang, li, wang]),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sub: '100051:1003', name: '王五', listed: false });
  });

  it('搜索无结果时返回空数组，让弹窗显示空态', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      query: '不存在的账号',
      repo: memoryRepo(['100051:1001', '100051:1002']),
      client: gateway([zhang, li, wang]),
    });

    expect(candidates).toEqual([]);
  });

  it('名单项不在网关最近一页时，按 sub 精确补齐姓名', async () => {
    // 最近一页只有张三、李四；王五是更早的开户，只能靠精确查补出来
    const client = gatewayWithTruncatedPage([zhang, li, wang], [zhang, li]);
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      repo: memoryRepo(['100051:1001', '100051:1003']),
      client,
    });

    expect(candidates.find((item) => item.sub === '100051:1003')).toMatchObject({
      name: '王五',
      email: wang.email,
      listed: true,
    });

    // 只对「缺邮箱的名单项」发精确查询，已在最近一页里的不再重复查
    const lookups = client.calls
      .map((call) => (call.request?.query ?? {}) as { external_user_id?: string })
      .filter((query) => query.external_user_id)
      .map((query) => query.external_user_id);
    expect(lookups).toEqual(['100051:1003']);
  });

  it('精确补齐失败时降级为 sub，不影响名单展示', async () => {
    const client = fakeClient((call) => {
      const query = (call.request?.query ?? {}) as { email?: string; external_user_id?: string };
      if (query.external_user_id) return new Error('gateway down');
      if (query.email) return wrap([], { total: 0, page: 1, page_size: 20 });
      return wrap([], { total: 0, page: 1, page_size: 20 });
    });

    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      repo: memoryRepo(['100051:1001', '100051:1003']),
      client,
    });

    expect(candidates.map((item) => item.sub).sort()).toEqual(['100051:1001', '100051:1003']);
    expect(candidates.every((item) => item.name === item.sub)).toBe(true);
  });
});
