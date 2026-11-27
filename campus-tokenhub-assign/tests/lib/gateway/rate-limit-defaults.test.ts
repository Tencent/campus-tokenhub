/**
 * 存量用户回填/刷新的行为：默认只补空缺，`overwrite: true` 才覆盖已有配置。
 *
 * 这里用假 client 直接断言「哪些用户被 PATCH、写了什么」，不碰网络；
 * 重点是三个不能退化的性质：不覆盖、幂等计数、单条失败不中断。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import {
  ensureConfigOverlayLoaded,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import { storedConfig } from '../../helpers/config';
import {
  DefaultRateLimitMissingError,
  applyDefaultRateLimitToUsers,
} from '@/lib/gateway/rate-limit-defaults';
import type { GatewayClient } from '@/lib/gateway/client';
import type { GatewayUser } from '@/lib/gateway/types';

const BASE_ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'admin-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'rate-limit-defaults-session-secret-32-chars',
};

const original = { ...process.env };

/**
 * 空默认限流的护栏仍要覆盖：base 已改为固定默认 50/500000，env 清空不再产生「未配置」。
 * 这里仅在该用例里把 readDefaultRateLimit 打桩成双 null，验证拒绝执行逻辑本身不退化。
 */
const missingLimit = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/config/quota', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/config/quota')>();
  return {
    ...actual,
    readDefaultRateLimit: (config?: Parameters<typeof actual.readDefaultRateLimit>[0]) =>
      missingLimit.enabled
        ? { rpm: null, tpm: null }
        : actual.readDefaultRateLimit(config),
  };
});

beforeEach(async () => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
  // 开户默认限流只存数据库：用 overlay 注入「设置页已配置」的效果
  setOverlayLoader(async () =>
    storedConfig({ defaultRateLimitRpm: 60, defaultRateLimitTpm: 200000 })
  );
  await ensureConfigOverlayLoaded();
});

afterEach(() => {
  missingLimit.enabled = false;
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

function user(id: string, rateLimit: unknown): GatewayUser {
  return {
    id,
    email: `${id}@example.com`,
    budget_max: 100,
    budget_base: 100,
    budget_spent: 0,
    budget_period: 'monthly',
    budget_reset_at: null,
    wallet_granted: 0,
    wallet_spent: 0,
    rate_limit: rateLimit,
    status: 'active',
    external_system: 'campus-tokenhub',
    external_user_id: id,
    active_keys_count: 0,
    created_at: null,
  };
}

function fakeClient(rows: GatewayUser[], failOn: string[] = []) {
  const patches: { path: string; body: unknown }[] = [];
  const client = {
    async admin(path: string, request?: { method?: string; body?: unknown }) {
      if (request?.method === 'PATCH') {
        const id = decodeURIComponent(path.split('/').pop() ?? '');
        if (failOn.includes(id)) throw new Error(`patch failed: ${id}`);
        patches.push({ path, body: request.body });
        return { success: true };
      }
      return { data: rows, total: rows.length, page: 1, page_size: 100 };
    },
    async publicGet() {
      throw new Error('not used');
    },
  } as unknown as GatewayClient;
  return { client, patches };
}

describe('applyDefaultRateLimitToUsers', () => {
  it('只补没有限流的用户（默认不覆盖）', async () => {
    const { client, patches } = fakeClient([user('a', null), user('b', { rpm: 5 })]);
    const result = await applyDefaultRateLimitToUsers({}, client);

    expect(result).toEqual({
      scanned: 2,
      updated: 1,
      overwritten: 0,
      skipped: 1,
      failed: 0,
      overwrite: false,
    });
    expect(patches).toHaveLength(1);
    expect(patches[0].path).toContain('/a'); // 只补了没有限流的那个
    expect(patches[0].body).toMatchObject({ rate_limit: { rpm: 60, tpm: 200000 } });
  });

  it('overwrite=true 时连已配置的用户一起刷新，并单独计数', async () => {
    const { client, patches } = fakeClient([user('a', null), user('b', { rpm: 5 })]);
    const result = await applyDefaultRateLimitToUsers({ overwrite: true }, client);

    expect(result).toEqual({
      scanned: 2,
      updated: 2,
      overwritten: 1,
      skipped: 0,
      failed: 0,
      overwrite: true,
    });
    expect(patches).toHaveLength(2);
    for (const patch of patches) {
      expect(patch.body).toMatchObject({
        rate_limit: { rpm: 60, tpm: 200000 },
        reason: 'portal:default_rate_limit_refresh',
      });
    }
  });

  it('单条失败只计数，不中断其余用户', async () => {
    const { client, patches } = fakeClient([user('a', null), user('b', null)], ['a']);
    const result = await applyDefaultRateLimitToUsers({}, client);

    expect(result.updated).toBe(1);
    expect(result.failed).toBe(1);
    expect(patches).toHaveLength(1);
  });

  it('未配置默认限流时拒绝执行，避免把所有人清成不限', async () => {
    // base 默认恒有值，这里直接打桩成双 null 来覆盖「未配置」这条拒绝路径
    missingLimit.enabled = true;
    try {
      const { client, patches } = fakeClient([user('a', { rpm: 5 })]);

      await expect(
        applyDefaultRateLimitToUsers({ overwrite: true }, client)
      ).rejects.toBeInstanceOf(DefaultRateLimitMissingError);
      expect(patches).toHaveLength(0);
    } finally {
      missingLimit.enabled = false;
    }
  });

  it('只写配置了的那一维（另一维不写成 0）', async () => {
    // 0 是有效值：只配置 RPM 时不能把 TPM 写成 0
    resetOverlayForTests();
    setOverlayLoader(async () => storedConfig({ defaultRateLimitRpm: 0 }));
    await ensureConfigOverlayLoaded();
    const { client, patches } = fakeClient([user('a', null)]);

    await applyDefaultRateLimitToUsers({}, client);
    expect(patches[0].body).toMatchObject({ rate_limit: { rpm: 0 } });
  });
});
