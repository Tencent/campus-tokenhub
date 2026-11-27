import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptConfigValue, resetConfigCryptoCache } from '@/lib/config/crypto';
import {
  ConfigStoreError,
  applyConfigChanges,
  clearConfigEntry,
  readStoredConfig,
  storedValue,
  writeConfigEntries,
  type ConfigRepo,
} from '@/lib/config/store';
import {
  PORTAL_SCHEMA_STATEMENTS,
  LOGIN_CONFIG_CLEANUP_SQL,
  LOGIN_CONFIG_MIGRATION_SQL,
  buildStructuredConfigMigrationSql,
} from '@/lib/db/portal-schema';
import {
  APP_FIELDS,
  FIELDS,
  LOGIN_FIELDS,
  type ConfigField as FieldId,
} from '@/lib/config/fields';
import { memoryConfigRepo } from '../../helpers/config';

const ENV = { SESSION_SECRET: 'test-session-secret-value-32-chars-long' };
const original = { ...process.env };

beforeEach(() => {
  process.env = { ...original, ...ENV };
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCryptoCache();
});

describe('config store', () => {
  it('写入后可读回，类型由字段描述符还原', async () => {
    const { repo } = memoryConfigRepo();
    await writeConfigEntries({ values: { schoolName: '某某大学' } }, repo);

    const stored = await readStoredConfig(repo);
    expect(storedValue(stored, 'schoolName')).toBe('某某大学');
    expect(stored.brokenFields).toEqual([]);
  });

  it('未知字段被拒绝，且不写入任何行', async () => {
    const { repo, state } = memoryConfigRepo();
    await expect(
      writeConfigEntries({ values: { ['portal.unknown' as FieldId]: 'x' } }, repo)
    ).rejects.toBeInstanceOf(ConfigStoreError);
    expect(state.calls.write).toBe(0);
  });

  it('任一字段校验失败时整份不写', async () => {
    const { repo, state } = memoryConfigRepo();
    await expect(
      writeConfigEntries(
        { values: { schoolName: '某某大学', defaultBudgetMax: -1 } },
        repo
      )
    ).rejects.toBeInstanceOf(ConfigStoreError);
    expect(state.calls.write).toBe(0);
    expect(Object.keys(state.values)).toHaveLength(0);
  });

  it('清除字段会把结构化列置 NULL', async () => {
    const { repo, state } = memoryConfigRepo();
    await writeConfigEntries({ values: { schoolName: '某某大学' } }, repo);
    await clearConfigEntry('schoolName', repo);

    expect(state.values.schoolName).toBeNull();
    expect((await readStoredConfig(repo)).app.schoolName).toBeNull();
  });

  it('审计写入失败不影响配置写入', async () => {
    const { repo, state } = memoryConfigRepo();
    const failing = { ...repo, async insertAudit(): Promise<void> { throw new Error('audit down'); } };

    await expect(
      writeConfigEntries({ values: { schoolName: '某某大学' } }, failing)
    ).resolves.toBeUndefined();

    expect(state.values.schoolName).toBe('某某大学');
  });

  it('写入与清除在同一事务里提交', async () => {
    const order: string[] = [];
    const { repo: baseRepo } = memoryConfigRepo();
    const tracking: ConfigRepo = {
      ...baseRepo,
      async write(writes: Parameters<typeof baseRepo.write>[0]) {
        order.push('write');
        await baseRepo.write(writes);
      },
      async clear(fields: FieldId[]) {
        order.push('clear');
        await baseRepo.clear(fields);
      },
      async transaction<T>(fn: (tx: ConfigRepo) => Promise<T>): Promise<T> {
        return fn(tracking);
      },
    };

    await applyConfigChanges({ values: { schoolName: '某某大学' }, clear: ['loginTitle'] }, tracking);
    expect(order).toEqual(['write', 'clear']);
  });

});

describe('结构化字段模型与 DDL', () => {
  it('每个描述符都有列名、审计名，密钥字段还有 cryptoKey', () => {
    for (const field of Object.keys(FIELDS) as FieldId[]) {
      expect(FIELDS[field].column).toBeTruthy();
      expect(FIELDS[field].auditName).toBeTruthy();
      if (FIELDS[field].secret) expect(FIELDS[field].cryptoKey).toBeTruthy();
    }
  });

  it('建表语句覆盖全部结构化列', () => {
    const appDdl = PORTAL_SCHEMA_STATEMENTS.find((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS portal_shared.app_config')
    );
    const loginDdl = PORTAL_SCHEMA_STATEMENTS.find((sql) =>
      sql.includes('CREATE TABLE IF NOT EXISTS portal_shared.login_config')
    );
    for (const field of Object.keys(APP_FIELDS) as FieldId[]) {
      expect(appDdl).toContain(FIELDS[field].column);
    }
    for (const field of Object.keys(LOGIN_FIELDS) as FieldId[]) {
      expect(loginDdl).toContain(FIELDS[field].column);
    }
  });

  it('登录配置分表与迁移 SQL 仍覆盖旧 EAV 拆分', () => {
    expect(LOGIN_CONFIG_MIGRATION_SQL).toContain("LIKE 'auth.%'");
    expect(LOGIN_CONFIG_CLEANUP_SQL).toContain('DELETE FROM portal_shared.app_config');
    const migration = buildStructuredConfigMigrationSql();
    expect(migration.app).toContain('portal_shared.app_config_eav_legacy');
    expect(migration.login).toContain('portal_shared.login_config_eav_legacy');
  });

  it('加密辅助与字段模型使用同一前缀', () => {
    expect(encryptConfigValue('x', 'portal.logo')).toMatch(/^v1:/);
  });

  it('共享层表名只来自 tables.ts（src 里不出现硬编码的 portal.<table>）', async () => {
    // 背景：表从 `portal` 迁到 `portal_shared` 后，`insertAudit` 仍写着
    // `INSERT INTO portal.config_audit`。审计 INSERT 报错又把同一个事务回滚了，
    // 表现为「保存成功、配置没变」。这条从源码层面把硬编码的旧 schema 钉死。
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    // 只认 SQL 语句位置（INSERT INTO / FROM / UPDATE ...）：注释与审计 target 文案里的
    // `portal.settings` 属于正常用法，不该误报
    const STALE =
      /\b(?:INSERT\s+INTO|FROM|UPDATE|JOIN)\s+portal\.(?:admins|app_config|login_config|settings|session_revocations|config_audit)\b/i;

    const root = path.join(process.cwd(), 'src');
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name)) continue;
        if (STALE.test(readFileSync(full, 'utf8'))) hits.push(path.relative(process.cwd(), full));
      }
    };
    walk(root);

    expect(hits).toEqual([]);
  });

});
