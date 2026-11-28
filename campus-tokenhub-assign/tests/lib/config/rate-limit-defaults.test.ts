/**
 * 开户默认限流：env 解析、DB overlay 覆盖、以及折成网关 payload 的三态。
 *
 * 重点在「0 是有效值」：`0` 表示拒绝全部，只有 null / 留空才是「不限」，
 * 所以这里既不能 `||` 也不能 `?? 0`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigCache } from '@/lib/config';
import { applyOverlay, resetOverlayForTests } from '@/lib/config/overlay';
import { toGatewayRateLimit, type DefaultRateLimit } from '@/lib/config/quota';
import { storedConfig } from '../../helpers/config';

const BASE_ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_API_KEY: 'sk-admin-9f2c4b7e6a1d8c530b4e2f7a9c6d1e8035',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'rate-limit-defaults-session-secret-32-chars',
};

const original = { ...process.env };

beforeEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

function limit(partial: Partial<DefaultRateLimit>): DefaultRateLimit {
  return { rpm: null, tpm: null, ...partial };
}

describe('toGatewayRateLimit', () => {
  it('returns null when neither dimension is configured', () => {
    expect(toGatewayRateLimit(limit({}))).toBeNull();
  });

  it('keeps 0 (deny all) instead of treating it as unlimited', () => {
    expect(toGatewayRateLimit(limit({ rpm: 0 }))).toEqual({ rpm: 0 });
    expect(toGatewayRateLimit(limit({ tpm: 0 }))).toEqual({ tpm: 0 });
    expect(toGatewayRateLimit(limit({ rpm: 0, tpm: 0 }))).toEqual({ rpm: 0, tpm: 0 });
  });

  it('carries only the configured dimensions', () => {
    expect(toGatewayRateLimit(limit({ rpm: 60 }))).toEqual({ rpm: 60 });
    expect(toGatewayRateLimit(limit({ tpm: 200000 }))).toEqual({ tpm: 200000 });
    expect(toGatewayRateLimit(limit({ rpm: 60, tpm: 200000 }))).toEqual({
      rpm: 60,
      tpm: 200000,
    });
  });
});

describe('base 配置的默认限流', () => {
  it('未配置时回落默认 rpm 50 / tpm 500000', () => {
    const cfg = loadConfig(BASE_ENV);
    expect(cfg.defaults.rateLimitRpm).toBe(50);
    expect(cfg.defaults.rateLimitTpm).toBe(500000);
  });

  it('不再读取 DEFAULT_RATE_LIMIT_* 环境变量', () => {
    const cfg = loadConfig({
      ...BASE_ENV,
      DEFAULT_RATE_LIMIT_RPM: '60',
      DEFAULT_RATE_LIMIT_TPM: '0',
    });
    expect(cfg.defaults.rateLimitRpm).toBe(50);
    expect(cfg.defaults.rateLimitTpm).toBe(500000);
  });
});

describe('overlay 覆盖默认限流', () => {
  it('DB 有值时覆盖 base 默认值', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(
      base,
      storedConfig({ defaultRateLimitRpm: 60, defaultRateLimitTpm: 200000 })
    );
    expect(merged.defaults.rateLimitRpm).toBe(60);
    expect(merged.defaults.rateLimitTpm).toBe(200000);
  });

  it('DB 为 NULL 时保持 base 默认', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(base, storedConfig({}));
    expect(merged.defaults.rateLimitRpm).toBe(50);
    expect(merged.defaults.rateLimitTpm).toBe(500000);
  });

  it('不修改传入的 base', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(base, storedConfig({ defaultRateLimitRpm: 60 }));
    expect(base.defaults.rateLimitRpm).toBe(50);
    expect(merged.defaults.rateLimitRpm).toBe(60);
  });
});
