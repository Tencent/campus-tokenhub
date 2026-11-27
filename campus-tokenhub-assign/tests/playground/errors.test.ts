import { describe, expect, it } from 'vitest';
import { explainError, readGatewayError } from '@/lib/playground/errors';

describe('explainError', () => {
  it('gateway.no_route：提示换模型', () => {
    const explained = explainError({ status: 404, code: 'gateway.no_route', message: 'No available route' });

    expect(explained.title).toContain('路由');
    expect(explained.rawMessage).toBe('No available route');
  });

  it('gateway.auth_failed：指向密钥页', () => {
    expect(explainError({ status: 401, code: 'gateway.auth_failed' }).hint).toContain('密钥');
  });

  it('额度不足有独立文案', () => {
    const explained = explainError({ status: 403, code: 'gateway.budget_exceeded' });
    expect(explained.title).toContain('额度');
  });

  it('401007：说明是控制台未开通，不是用法问题', () => {
    const explained = explainError({ status: 402, code: '401007' });

    expect(explained.title).toContain('未在控制台开通');
    expect(explained.hint).toContain('管理员');
  });

  it('熔断给出倒计时，并说明换模型也没用', () => {
    const explained = explainError({
      status: 429,
      code: 'circuit.upstream_capacity_exhausted',
      retryAfterSeconds: 120,
    });

    expect(explained.retryAfterSeconds).toBe(120);
    expect(explained.title).toContain('2 分钟');
    expect(explained.hint).toContain('换模型');
  });

  it('upstream.* 归为上游异常', () => {
    expect(explainError({ status: 502, code: 'upstream.timeout' }).title).toContain('上游');
  });

  it('未知错误码回退通用文案但保留原始 message', () => {
    const explained = explainError({ status: 418, code: 'something.new', message: '原始错误' });

    expect(explained.title).toContain('418');
    expect(explained.hint).toContain('原始错误');
    expect(explained.rawMessage).toBe('原始错误');
  });

  it('连状态码都没有时也不抛错', () => {
    expect(() => explainError({})).not.toThrow();
    expect(explainError({}).title).toBe('请求失败');
  });
});

describe('readGatewayError', () => {
  it('读错误码与 Retry-After', () => {
    const headers = new Headers({
      'x-octafuse-error-code': 'circuit.upstream_capacity_exhausted',
      'retry-after': '300',
    });

    expect(readGatewayError(headers)).toEqual({
      code: 'circuit.upstream_capacity_exhausted',
      retryAfterSeconds: 300,
    });
  });

  it('缺头时返回 null，不抛错', () => {
    expect(readGatewayError(new Headers())).toEqual({ code: null, retryAfterSeconds: null });
  });

  it('Retry-After 非数字时忽略', () => {
    const headers = new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' });
    expect(readGatewayError(headers).retryAfterSeconds).toBeNull();
  });
});
