import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clientIpFromHeaders, trustProxyHeaders, TRUST_PROXY_HEADERS_ENV } from '@/lib/net/client-ip';

const original = process.env[TRUST_PROXY_HEADERS_ENV];

function headers(map: Record<string, string>) {
  const lower: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) lower[key.toLowerCase()] = value;
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

const WITH_FORWARDED = headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
const WITH_REAL_IP = headers({ 'x-real-ip': '203.0.113.8' });

beforeEach(() => {
  delete process.env[TRUST_PROXY_HEADERS_ENV];
});

afterEach(() => {
  if (original === undefined) delete process.env[TRUST_PROXY_HEADERS_ENV];
  else process.env[TRUST_PROXY_HEADERS_ENV] = original;
});

describe('trustProxyHeaders', () => {
  it('只有 true / 1 才算开启', () => {
    for (const value of ['true', 'TRUE', ' 1 ', '1']) {
      expect(trustProxyHeaders(value)).toBe(true);
    }
    for (const value of [undefined, '', 'false', '0', 'yes', 'on']) {
      expect(trustProxyHeaders(value)).toBe(false);
    }
  });
});

describe('clientIpFromHeaders', () => {
  it('默认（未开启）忽略代理头，返回统一 fallback', () => {
    expect(clientIpFromHeaders(WITH_FORWARDED)).toBe('unknown');
    expect(clientIpFromHeaders(WITH_REAL_IP)).toBe('unknown');
  });

  it('显式关闭时同样忽略代理头', () => {
    process.env[TRUST_PROXY_HEADERS_ENV] = 'false';
    expect(clientIpFromHeaders(WITH_FORWARDED)).toBe('unknown');
  });

  it('开启后取 X-Forwarded-For 最左段', () => {
    process.env[TRUST_PROXY_HEADERS_ENV] = 'true';
    expect(clientIpFromHeaders(WITH_FORWARDED)).toBe('203.0.113.7');
  });

  it('开启后 XFF 为空时回落 X-Real-IP', () => {
    process.env[TRUST_PROXY_HEADERS_ENV] = 'true';
    expect(clientIpFromHeaders(WITH_REAL_IP)).toBe('203.0.113.8');
  });

  it('开启但两个头都没有时返回自定义 fallback', () => {
    process.env[TRUST_PROXY_HEADERS_ENV] = 'true';
    expect(clientIpFromHeaders(headers({}), 'unknown')).toBe('unknown');
    expect(clientIpFromHeaders(headers({}), 'direct')).toBe('direct');
  });
});
