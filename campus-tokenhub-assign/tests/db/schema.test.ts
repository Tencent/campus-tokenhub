import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMINS_TABLE,
  APP_CONFIG_TABLE,
  CONFIG_AUDIT_TABLE,
  LOGIN_CONFIG_TABLE,
  SESSION_REVOCATIONS_TABLE,
  SETTINGS_TABLE,
  ownSchema,
  ownTable,
  sharedSchema,
  sharedTable,
  tables,
} from '@/lib/config/tables';

describe('数据层 schema 常量（assign 侧）', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('共享层固定为 portal_shared，本侧固定为 portal_assign', () => {
    expect(sharedSchema()).toBe('portal_shared');
    expect(ownSchema()).toBe('portal_assign');
  });

  it('共享层六张表全部带 portal_shared 前缀', () => {
    const shared = [
      ADMINS_TABLE,
      APP_CONFIG_TABLE,
      LOGIN_CONFIG_TABLE,
      SETTINGS_TABLE,
      SESSION_REVOCATIONS_TABLE,
      CONFIG_AUDIT_TABLE,
    ];
    for (const name of shared) {
      expect(name.startsWith('portal_shared.')).toBe(true);
    }
  });

  it('tables() 产出共享六表 + 本侧 activity_configs', () => {
    const all = tables();
    expect(all.admins).toBe('portal_shared.admins');
    expect(all.appConfig).toBe('portal_shared.app_config');
    expect(all.loginConfig).toBe('portal_shared.login_config');
    expect(all.settings).toBe('portal_shared.settings');
    expect(all.sessionRevocations).toBe('portal_shared.session_revocations');
    expect(all.configAudit).toBe('portal_shared.config_audit');
    expect(all.activityConfigs).toBe('portal_assign.activity_configs');
  });

  it('本侧表名拼接走 ownTable，不写死 schema', () => {
    expect(ownTable('anything')).toBe('portal_assign.anything');
    expect(sharedTable('anything')).toBe('portal_shared.anything');
  });

  it('环境变量不能改变 schema 名（防止运行期配置与静态 DDL 不一致）', async () => {
    vi.stubEnv('PORTAL_SCHEMA', 'hacked');
    vi.stubEnv('PORTAL_SHARED_SCHEMA', 'hacked');
    vi.resetModules();
    const mod = await import('@/lib/config/tables');
    expect(mod.sharedSchema()).toBe('portal_shared');
    expect(mod.ownSchema()).toBe('portal_assign');
  });
});

describe('SQL 插值回归', () => {
  it('DDL 源码里不存在「单引号字符串包裹 ${}」的写法（不会插值，PG 会在 $ 处报语法错）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(process.cwd(), 'src/lib/db/portal-schema.ts'), 'utf8');
    // 逐行找：以单引号开头且包含 ${ 的字符串字面量
    const bad = source
      .split('\n')
      .filter((line) => /^\s*'[^']*\$\{/.test(line));
    expect(bad).toEqual([]);
  });
});
