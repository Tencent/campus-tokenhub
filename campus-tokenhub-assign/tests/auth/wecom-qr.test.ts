import { describe, expect, it } from 'vitest';
import type { WecomAuthConfig } from '@/lib/config';
import { buildWecomQrLoginUrl, isWecomClient } from '@/lib/auth/providers/wecom';

const config: WecomAuthConfig = {
  corpId: 'ww-test',
  agentId: '1000002',
  secret: 'top-secret-do-not-leak',
  scope: 'snsapi_base',
};

describe('isWecomClient', () => {
  it('识别企微客户端 UA', () => {
    expect(isWecomClient('wxwork')).toBe(true);
    expect(
      isWecomClient(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 wxwork/4.1.0'
      )
    ).toBe(true);
  });

  it('普通浏览器不算企微客户端', () => {
    expect(
      isWecomClient(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'
      )
    ).toBe(false);
    // 微信内置浏览器也不是企微客户端：它走不到企微自建应用的网页授权
    expect(isWecomClient('Mozilla/5.0 iPhone MicroMessenger/8.0.40')).toBe(false);
  });

  it('UA 为空时返回 false', () => {
    expect(isWecomClient(null)).toBe(false);
    expect(isWecomClient('')).toBe(false);
  });
});

describe('buildWecomQrLoginUrl', () => {
  it('构造官方扫码入口参数并正确编码 redirect_uri / state', () => {
    const redirectUri =
      'https://portal.example.edu/tokenhub/portal/api/auth/callback?next=/overview&lang=zh';
    const state = 'state /+1';
    const url = buildWecomQrLoginUrl(config, { state }, redirectUri);

    expect(url.startsWith('https://login.work.weixin.qq.com/wwlogin/sso/login?')).toBe(true);
    const parsed = new URL(url);
    expect(parsed.searchParams.get('login_type')).toBe('CorpApp');
    expect(parsed.searchParams.get('appid')).toBe('ww-test');
    expect(parsed.searchParams.get('agentid')).toBe('1000002');
    expect(parsed.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('redirect_type')).toBe('callback');
    expect(url).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
    expect(url).toContain(`state=${encodeURIComponent(state)}`);
  });

  it('URL 不包含 Secret', () => {
    const url = buildWecomQrLoginUrl(config, { state: 'state-1' }, 'https://portal.example.edu/api/auth/callback');
    expect(url).not.toContain(config.secret);
  });
});
