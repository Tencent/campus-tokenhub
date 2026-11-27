import { beforeEach, describe, expect, it } from 'vitest';
import { fakeClient, wrap } from '../helpers/fake-client';
import { resetAdminRosterCache } from '@/lib/admin/roster';
import { getOnboardingState, markCompleted, resetOnboardingCache, resolveOwner } from '@/lib/onboarding/state';

describe('初始化 owner 与完成状态', () => {
  beforeEach(() => {
    resetOnboardingCache();
    resetAdminRosterCache();
  });

  function clientWithConfig(store: Map<string, string>) {
    return fakeClient(({ path, request }) => {
      if (path === '/api/admin/config' && request?.method === 'PUT') {
        const body = request.body as { key: string; value: string };
        store.set(body.key, body.value);
        return { success: true };
      }
      if (path === '/api/admin/config') {
        return wrap([...store].map(([key, value]) => ({ key, value })));
      }
      if (path === '/api/admin/providers') return wrap([]);
      if (path === '/api/admin/models') return wrap([]);
      if (path === '/api/admin/routes') return wrap([]);
      throw new Error(`未预期的请求：${path}`);
    });
  }

  it('第一个身份认领 owner，第二个身份只能读到同一个 owner', async () => {
    const store = new Map<string, string>();
    const client = clientWithConfig(store);

    const first = await resolveOwner('7:1', client);
    expect(first.isOwner).toBe(true);
    expect(first.claimed).toBe(true);
    expect(store.get('ONBOARDING_OWNER')).toBe('7:1');
    // 首次认领会尝试把 owner 加进全局管理员名单（portal.member_admins）；
    // 名单在数据库里，单测不连库，这里只要求认领本身不被写库失败影响

    const second = await resolveOwner('7:2', client);
    expect(second.isOwner).toBe(false);
    expect(second.owner).toBe('7:1');
    expect(store.get('ONBOARDING_OWNER')).toBe('7:1');
  });

  it('非 school_id:user_id 的身份（mock / OIDC 的邮箱 sub）不进管理员名单', async () => {
    const store = new Map<string, string>();
    const client = clientWithConfig(store);

    const result = await resolveOwner('teacher@school.edu', client);
    expect(result.isOwner).toBe(true);
    expect(store.get('ONBOARDING_OWNER')).toBe('teacher@school.edu');
    expect(store.has('MEMBER_ADMIN_SUBS')).toBe(false);
  });

  it('完成后 owner 与完成时间都从一条记录里解析', async () => {
    const store = new Map<string, string>([
      ['ONBOARDING_OWNER', 'stu-1'],
      ['ONBOARDING_COMPLETED', '2026-11-09T00:00:00.000Z|stu-1'],
    ]);
    const client = clientWithConfig(store);

    const resolution = await resolveOwner('stu-1', client);
    expect(resolution.completed).toBe(true);
    expect(resolution.isOwner).toBe(true);

    const other = await resolveOwner('stu-2', client);
    expect(other.isOwner).toBe(false);
  });

  it('markCompleted 写入带 owner 的完成标记', async () => {
    const store = new Map<string, string>([['ONBOARDING_OWNER', 'stu-1']]);
    const client = clientWithConfig(store);

    await markCompleted('stu-1', client);
    expect(store.get('ONBOARDING_COMPLETED')).toMatch(/\|stu-1$/);
  });

  it('状态汇总能识别 preset 里已存在的模型与路由', async () => {
    const store = new Map<string, string>();
    const client = fakeClient(({ path }) => {
      if (path === '/api/admin/config') return wrap([]);
      if (path === '/api/admin/providers')
        return wrap([{ id: 'tencent-tokenhub', name: 'Tencent TokenHub', api_key: 'sk-…mRil' }]);
      if (path === '/api/admin/models') return wrap([{ id: 'hy4' }, { id: 'unknown-model' }]);
      if (path === '/api/admin/routes') return wrap([{ id: 'route-1', model_id: 'hy4' }]);
      throw new Error(`未预期的请求：${path}`);
    });

    const state = await getOnboardingState(client);
    expect(state.providerExists).toBe(true);
    expect(state.existingKeyHint).toBe('sk-…mRil');
    expect(state.gatewaySeeded).toBe(true);
    expect(state.modelCount).toBe(1);
    expect(state.routeCount).toBe(1);
    expect(state.completed).toBe(false);
    expect(store.size).toBe(0);
  });
});
