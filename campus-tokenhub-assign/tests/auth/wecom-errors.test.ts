import { describe, expect, it } from 'vitest';
import { readableError } from '@/lib/auth/login-errors';

describe('企业微信登录错误文案', () => {
  it.each([
    ['wecom_not_member', '非本企业成员，无法登录，请联系管理员。'],
    ['wecom_token_failed', '企业微信认证服务通信失败，请稍后重试。'],
    ['wecom_userinfo_failed', '获取企业微信成员信息失败，请稍后重试。'],
    ['wecom_config_missing', '企业微信登录尚未配置完成，请联系管理员。'],
    [
      'wecom_qr_unavailable',
      '扫码登录暂不可用（访问域名与 PUBLIC_BASE_URL 不一致或组件加载失败），请使用企业微信网页授权。',
    ],
  ])('%s 返回固定中文文案', (code, expected) => {
    expect(readableError(code)).toBe(expected);
  });

  it('未知错误码与上游 errcode 都回落通用文案，不回显原始原因', () => {
    expect(readableError('wecom_unknown_code')).toBe('登录失败，请重试。');
    expect(readableError('40014 invalid userid')).toBe('登录失败，请重试。');
  });
});
