import { describe, expect, it } from 'vitest';
import { loadConfig, type AppConfig } from '@/lib/config';
import { applyOverlay } from '@/lib/config/overlay';
import { resolveBranding } from '@/lib/config/branding';
import type { ConfigField, ConfigValue } from '@/lib/config/fields';
import { appPath } from '@/lib/paths';
import { storedConfig } from '../helpers/config';

const ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'branding-test-session-secret-32-chars',
};

function configWith(values: Partial<Record<ConfigField, ConfigValue>> = {}): AppConfig {
  return applyOverlay(loadConfig(ENV), storedConfig(values));
}

describe('resolveBranding', () => {
  it('全部未配置时使用默认值', () => {
    const branding = resolveBranding({ config: configWith() });

    expect(branding.schoolName).toBe('学校');
    expect(branding.loginTitle).toBe('登录 MaaS工作台');
    expect(branding.loginSubtitle).toBe('');
    expect(branding.footerContact).toBe('');
    expect(branding.brandColor).toBe('#2557D6');
    expect(branding.logoUrl).toBe('');
    expect(branding.invalidKeys).toEqual([]);
  });

  it('登录身份带回的校名优先于配置，配置优先于默认值', () => {
    const config = configWith({ 'schoolName': '某某大学' });

    expect(resolveBranding({ config, sessionSchoolName: '第一分校' }).schoolName).toBe('第一分校');
    expect(resolveBranding({ config }).schoolName).toBe('某某大学');
    expect(resolveBranding({ config, sessionSchoolName: '   ' }).schoolName).toBe('某某大学');
  });

  it('文案与主题色取自配置', () => {
    const branding = resolveBranding({
      config: configWith({
        'loginTitle': '登录统一身份平台',
        'loginSubtitle': '用校内账号登录',
        'footerContact': '联系信息化办公室 010-1234',
        'brandColor': '#1f6feb',
      }),
    });

    expect(branding.loginTitle).toBe('登录统一身份平台');
    expect(branding.loginSubtitle).toBe('用校内账号登录');
    expect(branding.footerContact).toBe('联系信息化办公室 010-1234');
    expect(branding.brandColor).toBe('#1f6feb');
  });

  it('主题色非法时回落默认色并记入 invalidKeys', () => {
    // overlay 会过滤非法值，这里直接构造一份「配置里就是脏值」的对象，验证兜底路径
    const base = loadConfig(ENV);
    const dirty: AppConfig = { ...base, portal: { ...base.portal, brandColor: '#12' } };

    const branding = resolveBranding({ config: dirty });

    expect(branding.brandColor).toBe('#2557D6');
    expect(branding.invalidKeys).toContain('brandColor');
  });

  it('配置了 Logo 时返回带部署前缀与内容指纹的读取地址', () => {
    const branding = resolveBranding({ config: configWith({ 'logo': 'data:image/png;base64,AAA' }) });
    expect(branding.logoUrl).toMatch(
      new RegExp(`^${appPath('/api/portal/branding/logo')}\\?v=[0-9a-f]{8}$`)
    );
    // 内容变了 URL 就要变，否则浏览器会一直用缓存里的旧 Logo
    const other = resolveBranding({ config: configWith({ 'logo': 'data:image/png;base64,BBB' }) });
    expect(other.logoUrl).not.toBe(branding.logoUrl);
  });

  it('空白文案视为未配置（回落默认值）', () => {
    const branding = resolveBranding({ config: configWith({ 'loginTitle': '   ' }) });
    expect(branding.loginTitle).toBe('登录 MaaS工作台');
  });
});
