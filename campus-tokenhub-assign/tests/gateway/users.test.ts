import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import {
  ensureConfigOverlayLoaded,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import { storedConfig } from '../helpers/config';
import { GatewayError } from '@/lib/gateway/client';
import { findByExternalId, getUser, provisionUser } from '@/lib/gateway/users';
import { identityFromClaims } from '@/lib/auth/providers/identity';
import { fakeClient, wrap } from '../helpers/fake-client';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

const identity = { sub: 'student-1', email: 'a@school.edu', name: '张三' };

beforeEach(async () => {
  Object.assign(process.env, baseEnv);
  resetConfigCache();
  resetOverlayForTests();
  // 开户默认额度只存数据库：用 overlay 注入「设置页已配置 30」
  setOverlayLoader(async () =>
    storedConfig({ defaultBudgetMax: 30, defaultBudgetPeriod: 'monthly' })
  );
  await ensureConfigOverlayLoaded(1000);
});

afterEach(() => {
  resetConfigCache();
  resetOverlayForTests();
});

const sampleUser = {
  id: 'gw-1',
  email: 'a@school.edu',
  budget_max: 30,
  budget_base: 30,
  budget_spent: 1.5,
  budget_period: 'monthly',
  budget_reset_at: '2026-12-01 00:00:00+00',
  status: 'active',
  external_system: 'school-sso',
  external_user_id: 'student-1',
  active_keys_count: 1,
  created_at: '2026-11-01 00:00:00+00',
};

describe('provisionUser', () => {
  it('按外部身份幂等开户，入参含额度与外部 ID', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }, { message: 'User created or returned' }));

    const result = await provisionUser(identity, client);

    expect(result).toEqual({ ok: true, octafuseUserId: 'gw-1' });
    expect(client.calls[0].path).toBe('/api/admin/users');
    expect(client.calls[0].request).toMatchObject({
      method: 'POST',
      body: {
        email: 'a@school.edu',
        external_system: 'school-sso',
        external_user_id: 'student-1',
        budget_max: 30,
        budget_period: 'monthly',
      },
    });
  });

  it('邮箱缺失时用「姓名 + 外部 ID」造一个可读邮箱', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }));

    await provisionUser({ ...identity, email: '' }, client);

    expect((client.calls[0].request?.body as { email: string }).email).toBe('张三.student-1@school.local');
  });

  it('没有姓名时退回外部 ID，仍然保证唯一', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }));

    await provisionUser({ sub: '100094:17908', email: '', name: '' }, client);

    expect((client.calls[0].request?.body as { email: string }).email).toBe('100094-17908@school.local');
  });

  it('老账号只有 id 邮箱时，开户后顺手改成带姓名的', async () => {
    const client = fakeClient((call) =>
      call.request?.method === 'PATCH'
        ? wrap({ id: 'gw-1' })
        : wrap({ id: 'gw-1', email: '100094:17908@school.local' })
    );

    await provisionUser({ sub: '100094:17908', email: '', name: '张三' }, client);

    const patch = client.calls.find((call) => call.request?.method === 'PATCH');
    expect(patch?.path).toBe('/api/admin/users/gw-1');
    expect(patch?.request?.body).toEqual({ email: '张三.100094-17908@school.local' });
  });

  it('已经是带姓名的邮箱时不再 PATCH', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1', email: '张三.100094-17908@school.local' }));

    await provisionUser({ sub: '100094:17908', email: '', name: '张三' }, client);

    expect(client.calls.some((call) => call.request?.method === 'PATCH')).toBe(false);
  });

  it('改名失败不影响开户结果', async () => {
    const client = fakeClient((call) =>
      call.request?.method === 'PATCH'
        ? new GatewayError('email already linked', 409)
        : wrap({ id: 'gw-1', email: '100094:17908@school.local' })
    );

    await expect(
      provisionUser({ sub: '100094:17908', email: '', name: '张三' }, client)
    ).resolves.toEqual({ ok: true, octafuseUserId: 'gw-1' });
  });

  it('网关失败时返回 ok:false 而不抛异常', async () => {
    const client = fakeClient(() => new GatewayError('upstream down', 503, 'http_error'));

    const result = await provisionUser(identity, client);

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ error: 'upstream down' });
  });

  it('网关未返回 data.id 时也判为失败', async () => {
    const client = fakeClient(() => wrap({}));

    await expect(provisionUser(identity, client)).resolves.toMatchObject({ ok: false });
  });
});

/**
 * 开户邮箱的姓名前缀是「配置的字段映射 → 身份解析 → 开户」整条链路的产物。
 *
 * 上面这些用例都显式传 `email: ''`，正好绕开了 `identityFromClaims` 里对空邮箱的派生逻辑，
 * 2026-11-23 配置化改造把邮箱兜底从 provider 挪进 `toIdentity()` 后，姓名就是这么静默丢掉的。
 * 这里从 userinfo 原始 claims 开始跑，锁死这条接线。
 */
describe('开户邮箱的姓名（claims → 身份解析 → 开户）', () => {
  /** aie `/oauth2/user_info` 的真实形状：顶层 snake_case，没有 email */
  const aieClaims = {
    user_id: 10131002,
    user_name: '张亮',
    school_id: 100051,
    role_id: 3,
    role_name: '学生',
    school_name: '示例中学',
  };
  const aieFieldMap = {
    subject: '{school_id}:{user_id}',
    name: 'user_name',
    schoolCode: 'school_id',
    schoolName: 'school_name',
    roles: 'role_name',
  };

  it('认证方不返回邮箱时，身份派生的占位邮箱也要把姓名拼进去', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }));
    const resolved = identityFromClaims(aieClaims, aieFieldMap);

    // 身份层派生的是占位地址（没有姓名），开户时不能再原样用
    expect(resolved.email).toBe('100051-10131002@school.local');
    expect(resolved.name).toBe('张亮');

    await provisionUser(resolved, client);

    expect((client.calls[0].request?.body as { email: string }).email).toBe(
      '张亮.100051-10131002@school.local'
    );
  });

  it('姓名取不到时退回纯 ID，不拼出 {id}.{id}@ 这种垃圾地址', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }));
    const { user_name: _omitted, ...withoutName } = aieClaims;
    const resolved = identityFromClaims(withoutName, aieFieldMap);

    // toIdentity 把 name 兜底成 sub，这里要能识别出「这不是姓名」
    expect(resolved.name).toBe('100051:10131002');

    await provisionUser(resolved, client);

    expect((client.calls[0].request?.body as { email: string }).email).toBe(
      '100051-10131002@school.local'
    );
  });
});

describe('存量占位邮箱补姓名', () => {
  /** 网关里已有的短横版占位邮箱（新链路 11/23 之后开出来的账号都是这个形状） */
  it('短横版占位邮箱：登录后 PATCH 成带姓名的版本', async () => {
    const client = fakeClient((call) =>
      call.request?.method === 'PATCH'
        ? wrap({ id: 'gw-1' })
        : wrap({ id: 'gw-1', email: '100051-10131002@school.local' })
    );

    await provisionUser(
      { sub: '100051:10131002', email: '100051-10131002@school.local', name: '张亮' },
      client
    );

    const patch = client.calls.find((call) => call.request?.method === 'PATCH');
    expect(patch?.path).toBe('/api/admin/users/gw-1');
    expect(patch?.request?.body).toEqual({ email: '张亮.100051-10131002@school.local' });
  });

  it('姓名里带空格时不生成非法邮箱', async () => {
    const client = fakeClient(() => wrap({ id: 'gw-1' }));

    await provisionUser(
      { sub: '100051:10131002', email: '100051-10131002@school.local', name: '张 亮' },
      client
    );

    expect((client.calls[0].request?.body as { email: string }).email).toBe(
      '张亮.100051-10131002@school.local'
    );
  });

  it('占位邮箱但没有姓名时不做无意义 PATCH', async () => {
    const client = fakeClient(() =>
      wrap({ id: 'gw-1', email: '100051-10131002@school.local' })
    );

    await provisionUser(
      { sub: '100051:10131002', email: '100051-10131002@school.local', name: '100051:10131002' },
      client
    );

    expect(client.calls.some((call) => call.request?.method === 'PATCH')).toBe(false);
  });
});

describe('findByExternalId', () => {
  it('命中时返回单条', async () => {
    const client = fakeClient(() => wrap([sampleUser], { total: 1 }));

    const user = await findByExternalId('student-1', client);

    expect(user?.id).toBe('gw-1');
    expect(client.calls[0].request?.query).toMatchObject({
      external_system: 'school-sso',
      external_user_id: 'student-1',
    });
  });

  it('未命中返回 null', async () => {
    const client = fakeClient(() => wrap([], { total: 0 }));

    await expect(findByExternalId('nobody', client)).resolves.toBeNull();
  });
});

describe('getUser', () => {
  it('解析额度字段', async () => {
    const client = fakeClient(() => wrap(sampleUser));

    const user = await getUser('gw-1', client);

    expect(user.budget_spent).toBe(1.5);
    expect(user.budget_max).toBe(30);
    expect(user.status).toBe('active');
    expect(client.calls[0].path).toBe('/api/admin/users/gw-1');
  });
});
