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
  it('载荷里不再带 L1 部署参数（连接串 / 容器地址）', async () => {
    process.env.PORTAL_DATABASE_URL = 'postgres://u:ssw0rd@db:5432/x';
    const { loadSettingsPayload } = await import('@/lib/config/settings-view');
    const payload = await loadSettingsPayload();

    const json = JSON.stringify(payload);
    expect(json).not.toContain('ssw0rd');
    expect(json).not.toContain('gateway-admin:8789');
  });

});
