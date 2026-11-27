import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, loadConfig, resetConfigCache } from '@/lib/config';
import {
  OVERLAY_TTL_MS,
  applyOverlay,
  enableOverlayAutoRefresh,
  ensureConfigOverlayFresh,
  getOverlaySnapshot,
  invalidateConfigOverlay,
  readOverlayStatus,
  refreshConfigOverlay,
  resetOverlayForTests,
  setOverlayLoader,
} from '@/lib/config/overlay';
import type { ConfigField, ConfigValue } from '@/lib/config/fields';
import type { StoredConfig } from '@/lib/config/store';
import { storedConfig } from '../../helpers/config';

const BASE_ENV = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  OCTAFUSE_ADMIN_USERNAME: 'admin',
  OCTAFUSE_ADMIN_PASSWORD: 'T3st-Admin-Pass-9f2c',
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'overlay-test-session-secret-32-characters',
};

const original = { ...process.env };

function overlay(values: Partial<Record<ConfigField, ConfigValue>>): StoredConfig {
  return storedConfig(values);
}

beforeEach(() => {
  process.env = { ...original, ...BASE_ENV };
  resetConfigCache();
  resetOverlayForTests();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
});

describe('applyOverlay', () => {
  it('DB 有值时覆盖 env', () => {
    const base = loadConfig({ ...BASE_ENV, PORTAL_SCHOOL_NAME: '演示学校' });
    const merged = applyOverlay(base, overlay({ schoolName: '某某大学' }));

    expect(merged.portal.schoolName).toBe('某某大学');
  });

  it('DB 无该字段时保持默认值（配置只存数据库，env 不再兜底）', () => {
    const base = loadConfig({ ...BASE_ENV, PORTAL_SCHOOL_NAME: '演示学校' });
    expect(applyOverlay(base, overlay({})).portal.schoolName).toBe('学校');

    const withDb = applyOverlay(base, overlay({ schoolName: '某某大学' }));
    expect(withDb.portal.schoolName).toBe('某某大学');
  });

  it('不修改传入的 base（纯函数）', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(base, overlay({ schoolName: '某某大学' }));

    expect(base.portal.schoolName).toBe('学校');
    expect(merged).not.toBe(base);
    expect(merged.portal).not.toBe(base.portal);
  });

  it('未声明的字段不会改变配置', () => {
    const base = loadConfig(BASE_ENV);
    const merged = applyOverlay(base, overlay({}));
    expect(merged.portal.schoolName).toBe('学校');
  });

  it('登录配置也按类型化字段覆盖，并归一化 URL', () => {
    const base = loadConfig(BASE_ENV);
    const conditions = [
      { field: 'schoolCode' as const, path: '', value: '1001' },
      { field: 'roles' as const, path: '', value: '老师' },
    ];
    const merged = applyOverlay(base, overlay({
      provider: 'oauth2',
      oauth2AuthorizationEndpoint: 'https://idp.example.com/auth/',
      oauth2ClientId: 'client-id',
      restrictEnabled: true,
      restrictConditions: conditions,
    }));

    expect(merged.auth.oauth2.authorizationEndpoint).toBe('https://idp.example.com/auth');
    expect(merged.auth.oauth2.clientId).toBe('client-id');
    expect(merged.auth.restrict.enabled).toBe(true);
    expect(merged.auth.restrict.conditions).toEqual(conditions);
  });

});

describe('overlay 生命周期', () => {
  it('刷新后 getConfig 反映 DB 值，并登记敏感值供脱敏使用', async () => {
    setOverlayLoader(async () => storedConfig(
      { schoolName: '某某大学' },
      { secretPlaintexts: ['AKIDfromDB123456'] }
    ));

    await refreshConfigOverlay();
    expect(getConfig().portal.schoolName).toBe('某某大学');
    expect(readOverlayStatus().loaded).toBe(true);
  });

  it('失效后 getConfig 回到 env 值', async () => {
    setOverlayLoader(async () => overlay({ schoolName: '某某大学' }));
    await refreshConfigOverlay();
    expect(getConfig().portal.schoolName).toBe('某某大学');

    invalidateConfigOverlay();
    expect(getConfig().portal.schoolName).toBe('学校');
  });

  it('快照超过 TTL 时返回旧值并触发一次后台刷新', async () => {
    const loader = vi.fn(async () => overlay({ schoolName: '某某大学' }));
    setOverlayLoader(loader);
    await refreshConfigOverlay();
    expect(loader).toHaveBeenCalledTimes(1);

    enableOverlayAutoRefresh();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + OVERLAY_TTL_MS + 1_000);

    const snapshot = getOverlaySnapshot();
    expect(snapshot.stored?.app.schoolName).toBe('某某大学');

    await vi.waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });

  it('ensureConfigOverlayFresh 会等刷新拿到刚写入的新值（TTL 内也不返回旧快照）', async () => {
    // 背景：保存配置后立刻打开页面，快照还在 TTL 内但已是旧值，
    // 同步的 getOverlaySnapshot() 会把旧值交出去 —— 表现为「后台已经改成 off，
    // 登录页还留着密码表单 / 设置页横幅还提示 on」。
    let schoolName = '旧校名';
    setOverlayLoader(async () => overlay({ schoolName }));
    enableOverlayAutoRefresh();
    await refreshConfigOverlay();
    expect(getConfig().portal.schoolName).toBe('旧校名');

    schoolName = '新校名';
    // 仍在 TTL 内：同步读取拿到的仍是旧值
    expect(getOverlaySnapshot().stored?.app.schoolName).toBe('旧校名');

    await ensureConfigOverlayFresh();
    expect(getConfig().portal.schoolName).toBe('新校名');
  });

  it('刷新进行中再次调用不会并发触发第二次', async () => {
    let release: (value: StoredConfig) => void = () => undefined;
    const loader = vi.fn(
      () => new Promise<StoredConfig>((resolve) => { release = resolve; })
    );
    setOverlayLoader(loader);

    const first = refreshConfigOverlay();
    const second = refreshConfigOverlay();
    expect(loader).toHaveBeenCalledTimes(1);

    release(overlay({ schoolName: '某某大学' }));
    await Promise.all([first, second]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('加载失败时保留旧快照', async () => {
    setOverlayLoader(async () => overlay({ schoolName: '某某大学' }));
    await refreshConfigOverlay();

    setOverlayLoader(async () => { throw new Error('db down'); });
    await refreshConfigOverlay();

    expect(readOverlayStatus().loaded).toBe(true);
    expect(getConfig().portal.schoolName).toBe('某某大学');
  });

  it('数据库未配置时返回空 overlay 且不抛错', async () => {
    delete process.env.PORTAL_DATABASE_URL;
    delete process.env.DATABASE_URL;
    setOverlayLoader(null);

    await expect(refreshConfigOverlay()).resolves.toBeUndefined();
    // 无 DB 时 loader 返回空结构化配置：字段全 NULL，读取时回落 env/默认值
    expect(readOverlayStatus().stored?.app.schoolName).toBeNull();
  });

  it('edge 运行时直接短路，不调用 loader', async () => {
    const loader = vi.fn(async () => overlay({ schoolName: '某某大学' }));
    setOverlayLoader(loader);
    process.env.NEXT_RUNTIME = 'edge';

    await refreshConfigOverlay();
    expect(loader).not.toHaveBeenCalled();
    expect(getOverlaySnapshot().stored).toBeNull();
  });

  it('resetConfigCache 清空 overlay 并禁用自动刷新', async () => {
    const loader = vi.fn(async () => overlay({ schoolName: '某某大学' }));
    setOverlayLoader(loader);
    await refreshConfigOverlay();
    expect(loader).toHaveBeenCalledTimes(1);

    resetConfigCache();
    setOverlayLoader(loader);

    expect(getOverlaySnapshot().stored).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
