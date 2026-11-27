import { describe, expect, it } from 'vitest';
import { signRequest } from '@/lib/tencent/signature';

const base = {
  secretId: 'AKIDtest',
  secretKey: 'secret-key',
  host: 'organization.tencentcloudapi.com',
  action: 'DescribeOrganizationNodes',
  payload: '{"Limit":1,"Offset":0}',
  timestamp: 1794986400,
};

describe('TC3-HMAC-SHA256 签名', () => {
  it('同样的输入得到同样的 Authorization', () => {
    const a = signRequest(base);
    const b = signRequest(base);
    expect(a.authorization).toBe(b.authorization);
  });

  it('头格式符合腾讯云规范', () => {
    const { authorization, date } = signRequest(base);
    expect(date).toBe('2026-11-18');
    expect(authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=AKIDtest\/2026-11-18\/organization\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/
    );
  });

  it('payload 变化会改变签名', () => {
    const a = signRequest(base);
    const b = signRequest({ ...base, payload: '{"Limit":2,"Offset":0}' });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('时间戳变化会改变签名与日期', () => {
    const a = signRequest(base);
    const b = signRequest({ ...base, timestamp: base.timestamp + 86_400 });
    expect(a.authorization).not.toBe(b.authorization);
    expect(b.date).toBe('2026-11-19');
  });

  it('固定向量（回归锁）：2026-11-18 的签名不随实现重构漂移', () => {
    expect(signRequest(base).authorization).toBe(
      'TC3-HMAC-SHA256 Credential=AKIDtest/2026-11-18/organization/tc3_request, SignedHeaders=content-type;host, Signature=0dd53ec1a841642f0dff193d98993a8e86d1a9635e62804139e383b15ad2db0b'
    );
  });
});
