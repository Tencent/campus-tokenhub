import { beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { adminReturnUrl, sanitizeAdminNext } from '@/lib/auth/login';

function setEnv(overrides: Record<string, string> = {}): void {
  Object.assign(process.env, {
    OCTAFUSE_ADMIN_BASE: 'http://gateway-admin:8789',
    OCTAFUSE_PROXY_BASE: 'http://gateway-proxy:8787',
    // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
    OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
    SESSION_SECRET: 'unit-test-secret-that-is-long-enough',
    ...overrides,
  });
  resetConfigCache();
}

beforeEach(() => {
  delete process.env.ADMIN_PUBLIC_BASE_URL;
  setEnv();
});

describe('sanitizeAdminNext', () => {
  it('保留站内相对路径的 query 与片段', () => {
    expect(sanitizeAdminNext('/gateway/users/123?tab=keys')).toBe('/gateway/users/123?tab=keys');
    expect(sanitizeAdminNext('/gateway/users/123#section')).toBe('/gateway/users/123#section');
  });

  it('允许中文与空格（后续由 URL 构造器编码）', () => {
    expect(sanitizeAdminNext('/模型/用量 明细')).toBe('/模型/用量 明细');
  });

  it.each([
    ['//evil.example/x'],
    ['https://evil.example'],
    ['/\\evil.example'],
    ['/a\u0000b'],
    ['/a\nb'],
  ])('拒绝越界目标 %s，回落到根路径', (raw) => {
    expect(sanitizeAdminNext(raw)).toBe('/');
  });

  it('空值与 undefined 回落到根路径', () => {
    expect(sanitizeAdminNext('')).toBe('/');
    expect(sanitizeAdminNext(null)).toBe('/');
    expect(sanitizeAdminNext(undefined)).toBe('/');
  });
});

describe('adminReturnUrl', () => {
  it('用 ADMIN_PUBLIC_BASE_URL 拼回跳地址', () => {
    setEnv({ ADMIN_PUBLIC_BASE_URL: 'https://api.example.com/tokenhub/admin' });

    expect(adminReturnUrl('/gateway/users/1?tab=keys')).toBe(
      'https://api.example.com/tokenhub/admin/gateway/users/1?tab=keys'
    );
    expect(adminReturnUrl(null)).toBe('https://api.example.com/tokenhub/admin/');
  });

  it('基址带尾斜杠时不产生双斜杠', () => {
    setEnv({ ADMIN_PUBLIC_BASE_URL: 'https://api.example.com/tokenhub/admin/' });

    expect(adminReturnUrl('/gateway/users/1')).toBe(
      'https://api.example.com/tokenhub/admin/gateway/users/1'
    );
  });

  it('next 已带管理台公网前缀时不重复拼接（退出后重新登录回归）', () => {
    setEnv({ ADMIN_PUBLIC_BASE_URL: 'https://api.example.com/tokenhub/admin' });

    expect(adminReturnUrl('/tokenhub/admin/dashboard?start_date=2026-11-18')).toBe(
      'https://api.example.com/tokenhub/admin/dashboard?start_date=2026-11-18'
    );
    expect(adminReturnUrl('/tokenhub/admin')).toBe('https://api.example.com/tokenhub/admin/');
  });

  it('基址未配置时返回 null，不回落到容器内网地址', () => {
    setEnv();

    expect(adminReturnUrl('/gateway/users/1')).toBeNull();
    expect(adminReturnUrl(null)).toBeNull();
  });
});
