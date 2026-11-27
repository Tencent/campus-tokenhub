import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/lib/gateway/client';
import { providerKeyHint, revealProviderApiKey } from '@/lib/onboarding/gateway-state';
import { fakeClient, wrap } from '../helpers/fake-client';

describe('providerKeyHint', () => {
  it('回显网关列表里的脱敏预览', () => {
    expect(providerKeyHint({ id: 'p', name: 'n', api_key: 'sk-…x7Kp' })).toBe('sk-…x7Kp');
  });

  it('供应商不存在、空值或占位符都视为没有可复用的 Key', () => {
    expect(providerKeyHint(null)).toBeNull();
    expect(providerKeyHint({ id: 'p', name: 'n' })).toBeNull();
    expect(providerKeyHint({ id: 'p', name: 'n', api_key: '' })).toBeNull();
    expect(providerKeyHint({ id: 'p', name: 'n', api_key: '(empty)' })).toBeNull();
    expect(providerKeyHint({ id: 'p', name: 'n', api_key: '***' })).toBeNull();
  });
});

describe('revealProviderApiKey', () => {
  it('兼容带 data 外壳的响应', async () => {
    const client = fakeClient((call) => {
      expect(call.path).toBe('/api/admin/providers/tencent-tokenhub/api-key');
      return wrap({ api_key: 'sk-stored-0001' });
    });

    await expect(revealProviderApiKey('tencent-tokenhub', client)).resolves.toBe('sk-stored-0001');
  });

  it('兼容裸字段响应', async () => {
    const client = fakeClient(() => ({ api_key: 'sk-stored-0002' }));
    await expect(revealProviderApiKey('tencent-tokenhub', client)).resolves.toBe('sk-stored-0002');
  });

  it('空串按没有 Key 处理', async () => {
    const client = fakeClient(() => wrap({ api_key: '  ' }));
    await expect(revealProviderApiKey('tencent-tokenhub', client)).resolves.toBeNull();
  });

  it('供应商不存在（404）返回 null，其它错误照常抛出', async () => {
    const notFound = fakeClient(() => new GatewayError('Provider not found', 404, 'not_found'));
    await expect(revealProviderApiKey('tencent-tokenhub', notFound)).resolves.toBeNull();

    const broken = fakeClient(() => new GatewayError('网关返回 HTTP 500', 500, 'gateway_http_error'));
    await expect(revealProviderApiKey('tencent-tokenhub', broken)).rejects.toThrow('网关返回 HTTP 500');
  });
});
