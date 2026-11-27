import { beforeEach, describe, expect, it, vi } from 'vitest';

const dns = vi.hoisted(() => ({ lookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));

import { assertOutboundAllowed, assertPublicHttpUrl, isBlockedAddress } from '@/lib/security/url-guard';

beforeEach(() => {
  dns.lookup.mockReset();
});

describe('isBlockedAddress', () => {
  it('拦截回环 / 私网 / 链路本地 / CGNAT', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.9',
      '172.31.255.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it('放行公网地址', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2001:4860:4860::8888']) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });
});

describe('assertPublicHttpUrl', () => {
  it('只接受 http(s)', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd', '地址')).resolves.toMatchObject({
      ok: false,
    });
    await expect(assertPublicHttpUrl('ftp://example.com', '地址')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('拒绝带用户名密码的地址', async () => {
    await expect(
      assertPublicHttpUrl('https://user:pass@example.com', '地址')
    ).resolves.toMatchObject({ ok: false });
  });

  it('拒绝直连内网 IP（云元数据）', async () => {
    const result = await assertPublicHttpUrl('http://169.254.169.254/latest/meta-data', '地址');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('内网');
  });

  it('域名解析到私网时拒绝', async () => {
    dns.lookup.mockResolvedValue([{ address: '10.0.0.5' }]);

    const result = await assertPublicHttpUrl('https://idp.example.com', '认证地址');
    expect(result.ok).toBe(false);
  });

  it('域名解析失败给出可读提示', async () => {
    dns.lookup.mockRejectedValue(new Error('ENOTFOUND'));

    const result = await assertPublicHttpUrl('https://nope.example.com', '认证地址');
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('无法解析');
  });

  it('公网域名放行', async () => {
    dns.lookup.mockResolvedValue([{ address: '203.0.113.10' }]);

    const result = await assertPublicHttpUrl('https://idp.example.com/path?x=1', '认证地址');
    expect(result.ok).toBe(true);
    expect(result.ok ? result.url.toString() : '').toBe('https://idp.example.com/path?x=1');
  });
});

describe('assertOutboundAllowed（出站请求：只拦本机与云元数据）', () => {
  const strict = { enforce: true };

  it('拦截回环 / 链路本地 / 云元数据 / localhost', async () => {
    for (const target of [
      'http://127.0.0.1:8789/api/admin/config',
      'http://[::1]:3000/',
      'http://169.254.169.254/latest/meta-data',
      'http://100.100.100.200/latest/meta-data',
      'http://localhost:5432/',
      'http://idp.localhost/authorize',
      'http://metadata/computeMetadata/v1/',
      'http://0.0.0.0/',
    ]) {
      const result = await assertOutboundAllowed(target, '端点', strict);
      expect(result.ok, target).toBe(false);
    }
  });

  it('放行私网段（学校 SSO / 网关通常就在内网）', async () => {
    for (const target of [
      'https://10.20.30.40/cas/serviceValidate',
      'https://172.16.0.9/oauth/token',
      'https://192.168.1.10/.well-known/openid-configuration',
    ]) {
      const result = await assertOutboundAllowed(target, '端点', strict);
      expect(result.ok, target).toBe(true);
    }
  });

  it('域名解析到本机时拦截，解析到私网时放行', async () => {
    dns.lookup.mockResolvedValueOnce([{ address: '127.0.0.1' }]);
    await expect(
      assertOutboundAllowed('https://idp.example.com', '端点', strict)
    ).resolves.toMatchObject({ ok: false });

    dns.lookup.mockResolvedValueOnce([{ address: '10.1.2.3' }]);
    await expect(
      assertOutboundAllowed('https://idp.example.com', '端点', strict)
    ).resolves.toMatchObject({ ok: true });
  });

  it('非生产环境只告警不拦截（本地 IdP 常跑在 127.0.0.1）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await assertOutboundAllowed('http://127.0.0.1:8080/authorize', '端点', {
      enforce: false,
    });
    expect(result.ok).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('只接受 http(s)', async () => {
    await expect(
      assertOutboundAllowed('file:///etc/passwd', '端点', strict)
    ).resolves.toMatchObject({ ok: false });
  });

  it('生产默认强制；OUTBOUND_GUARD=off 时退化成只告警（逃生开关）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');

    await expect(assertOutboundAllowed('http://127.0.0.1:8080/cas', '端点')).resolves.toMatchObject({
      ok: false,
    });

    vi.stubEnv('OUTBOUND_GUARD', 'off');
    await expect(assertOutboundAllowed('http://127.0.0.1:8080/cas', '端点')).resolves.toMatchObject({
      ok: true,
    });
    expect(warn).toHaveBeenCalled();

    vi.unstubAllEnvs();
    warn.mockRestore();
  });
});
