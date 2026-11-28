import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/lib/config';
import { applyOverlay } from '@/lib/config/overlay';
import { readDefaultBudget, readDefaultRateLimit } from '@/lib/config/quota';
import { storedConfig } from '../helpers/config';

/**
 * 开户默认额度与默认限流的合并口径。
 *
 * 与成员站（member）的差异：统一采买站没有门户模式，本文件不再覆盖模式开关。
 */

const ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
  PUBLIC_BASE_URL: 'http://portal.test',
};

function configWith(values: Parameters<typeof storedConfig>[0] = {}) {
  return applyOverlay(loadConfig(ENV), storedConfig(values));
}

describe('开户默认额度', () => {
  it('未配置运行期值时回落 base 默认', () => {
    const budget = readDefaultBudget(configWith());

    expect(budget).toEqual({ budgetMax: 20, budgetPeriod: 'monthly' });
  });

  it('运行期值覆盖 env 默认', () => {
    const budget = readDefaultBudget(
      configWith({ defaultBudgetMax: 500, defaultBudgetPeriod: 'daily' })
    );

    expect(budget).toEqual({ budgetMax: 500, budgetPeriod: 'daily' });
  });
});

describe('开户默认限流', () => {
  it('两维都未配置时回落 base 默认 rpm 50 / tpm 500000', () => {
    expect(readDefaultRateLimit(configWith())).toEqual({ rpm: 50, tpm: 500000 });
  });

  it('运行期值分别覆盖两个维度', () => {
    const limit = readDefaultRateLimit(
      configWith({ defaultRateLimitRpm: 60, defaultRateLimitTpm: 200000 })
    );

    expect(limit).toEqual({ rpm: 60, tpm: 200000 });
  });

  it('0 是有效值（拒绝全部），不会被当成未配置', () => {
    const limit = readDefaultRateLimit(configWith({ defaultRateLimitRpm: 0 }));

    expect(limit.rpm).toBe(0);
  });
});
