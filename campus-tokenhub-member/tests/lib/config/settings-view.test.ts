import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { resetConfigStoreCache, setConfigRepoOverride } from '@/lib/config/store';
import { memoryConfigRepo } from '../../helpers/config';

const BASE_ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'admin-password',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'settings-view-test-session-secret-32ch',
};

const original = { ...process.env };

beforeEach(() => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetConfigStoreCache();
  const { repo } = memoryConfigRepo({ schoolName: '已存校名' });
  setConfigRepoOverride(repo);
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetConfigStoreCache();
});

describe('设置页载荷：显式存值 vs 当前生效值', () => {
  it('未存过的字段也要出现在 effective 里，否则页面显示成空', async () => {
    const { loadSettingsPayload } = await import('@/lib/config/settings-view');
    const payload = await loadSettingsPayload();

    // 只存过校名：values 只有这一个字段，页面据此无法回显其它项
    expect(payload.values.schoolName).toBe('已存校名');
    expect(payload.values.tencentPermissionIds).toBeUndefined();

    // effective 是「配置表 + env/默认值」：财务权限默认是 1、2、5、6
    expect(payload.effective.schoolName).toBe('已存校名');
    expect(payload.effective.tencentPermissionIds).toEqual([1, 2, 5, 6]);
  });

  it('载荷里不再带 L1 部署参数（连接串 / 容器地址）', async () => {
    process.env.PORTAL_DATABASE_URL = 'postgres://u:ssw0rd@db:5432/x';
    const { loadSettingsPayload } = await import('@/lib/config/settings-view');
    const payload = await loadSettingsPayload();

    const json = JSON.stringify(payload);
    expect(json).not.toContain('ssw0rd');
    expect(json).not.toContain('gateway-admin:8789');
  });

  it('只有可探测的分组才有验证状态，首页 / 登录认证不出现徽标', async () => {
    const { groupStatusKeys, loadSettingsPayload } = await import('@/lib/config/settings-view');

    // 首页配置（文案 / 颜色 / Logo）与登录认证（不对 IdP 发探测）没有验证动作
    expect(groupStatusKeys('school')).toEqual([]);
    expect(groupStatusKeys('auth')).toEqual([]);

    // 成员组织这组在保存后会真的探测，参与状态统计
    expect(groupStatusKeys('member')).toEqual(['tencentSecretId', 'tencentSecretKey']);

    const payload = await loadSettingsPayload();
    expect(payload.groupStatus.school).toBeUndefined();
    expect(payload.groupStatus.auth).toBeUndefined();
    expect(payload.groupStatus.member).toBe('unverified');
  });
});
