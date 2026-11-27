import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '@/lib/db/portal-db';
import {
  ensurePortalSchema,
  resetPortalSchemaCache,
} from '@/lib/db/portal-schema';
import {
  LEGACY_APP_CONFIG_TABLE,
  LEGACY_LOGIN_CONFIG_TABLE,
  STRUCTURED_MIGRATION_MARKER,
} from '@/lib/config/tables';
import { FIELDS } from '@/lib/config/fields';
import { encryptConfigValue } from '@/lib/config/crypto';
import { readStoredConfig } from '@/lib/config/store';
import type { Db } from '@/lib/db/portal-db';

const databaseUrl = process.env.PORTAL_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const LEGACY_COLUMNS = `
  key             text PRIMARY KEY,
  value_plain     text,
  value_enc       bytea,
  is_secret       boolean NOT NULL DEFAULT false,
  updated_by      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  verify_status   text NOT NULL DEFAULT 'unverified',
  verify_message  text,
  verified_at     timestamptz
`;

async function tableExists(db: Db, tableName: string): Promise<boolean> {
  const { rows } = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'portal' AND table_name = $1
     ) AS "exists"`,
    [tableName]
  );
  return Boolean(rows[0]?.exists);
}

/** 每个用例前把配置表恢复成「旧 EAV」形态，确保迁移路径真的跑到 */
async function seedLegacyTables(db: Db): Promise<void> {
  await db.query(`
    DROP TABLE IF EXISTS portal.app_config, portal.login_config,
      ${LEGACY_APP_CONFIG_TABLE}, ${LEGACY_LOGIN_CONFIG_TABLE} CASCADE
  `);
  await db.query('DELETE FROM portal.settings WHERE key = $1', [STRUCTURED_MIGRATION_MARKER]);
  await db.query(`CREATE TABLE portal.app_config (${LEGACY_COLUMNS})`);
  await db.query(`CREATE TABLE portal.login_config (${LEGACY_COLUMNS})`);
  resetPortalSchemaCache();
}

async function insertLegacy(
  db: Db,
  table: 'app_config' | 'login_config',
  key: string,
  valuePlain: string | null,
  options: { valueEnc?: string; verifyStatus?: string; verifyMessage?: string | null } = {}
): Promise<void> {
  await db.query(
    `INSERT INTO portal.${table}
       (key, value_plain, value_enc, is_secret, verify_status, verify_message, verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      key,
      valuePlain,
      options.valueEnc ? Buffer.from(options.valueEnc, 'utf8') : null,
      options.valueEnc ? true : false,
      options.verifyStatus ?? 'unverified',
      options.verifyMessage ?? null,
    ]
  );
}

suite('EAV → 结构化配置迁移（真实 Postgres）', () => {
  beforeEach(async () => {
    process.env.PORTAL_DATABASE_URL = databaseUrl;
    resetPortalSchemaCache();
    const db = getDb();
    await ensurePortalSchema();
    await seedLegacyTables(db);
  });

  afterAll(async () => {
    const db = getDb();
    // 集成测试会覆盖本地测试库的配置行，收尾清空，避免污染页面验证
    await db.query('DELETE FROM portal.app_config');
    await db.query('DELETE FROM portal.login_config');
    await closeDb();
  });

  it('旧列搬到结构化列，密文可用旧 cryptoKey 解开，legacy 表被删除', async () => {
    const db = getDb();
    const secretId = 'AKIDlegacy0001';
    const secretKey = 'legacy-secret-key';
    const clientSecret = 'legacy-oauth-secret';

    await insertLegacy(db, 'app_config', FIELDS.schoolName.auditName, '迁移测试学校');
    await insertLegacy(db, 'app_config', FIELDS.defaultBudgetMax.auditName, '250');
    await insertLegacy(db, 'app_config', FIELDS.tencentPermissionIds.auditName, '[1,2,3,3]');
    await insertLegacy(db, 'app_config', FIELDS.tencentSecretId.auditName, null, {
      valueEnc: encryptConfigValue(secretId, FIELDS.tencentSecretId.cryptoKey!),
      verifyStatus: 'ok',
    });
    await insertLegacy(db, 'app_config', FIELDS.tencentSecretKey.auditName, null, {
      valueEnc: encryptConfigValue(secretKey, FIELDS.tencentSecretKey.cryptoKey!),
      verifyStatus: 'failed',
      verifyMessage: 'legacy probe failed',
    });
    // 旧版本把 auth.* 混在 app_config 里，迁移应先拆到 login_config 再透视
    await insertLegacy(db, 'app_config', FIELDS.oauth2ClientSecret.auditName, null, {
      valueEnc: encryptConfigValue(clientSecret, FIELDS.oauth2ClientSecret.cryptoKey!),
    });
    await insertLegacy(db, 'login_config', FIELDS.provider.auditName, 'oauth2');
    // 旧模型是「一个字段 + 多个允许值」，迁移时每个值展开成一条独立条件
    await insertLegacy(db, 'login_config', 'auth.restrict.field', 'schoolCode');
    await insertLegacy(db, 'login_config', 'auth.restrict.allowedValues', '1001,1002');

    await ensurePortalSchema();

    const appRows = await db.query<{
      school_name: string;
      default_budget_max: number;
      tencent_permission_ids: number[];
      tencent_verify_status: string;
      tencent_verify_message: string | null;
    }>(`SELECT school_name, default_budget_max, tencent_permission_ids,
                tencent_verify_status, tencent_verify_message
           FROM portal.app_config WHERE singleton`);
    expect(appRows.rows[0]).toMatchObject({
      school_name: '迁移测试学校',
      default_budget_max: 250,
      tencent_permission_ids: [1, 2, 3, 3],
      tencent_verify_status: 'failed',
      tencent_verify_message: 'legacy probe failed',
    });

    const loginRows = await db.query<{
      provider: string;
      oauth2_client_secret_enc: Buffer;
      restrict_conditions: { field: string; path: string; value: string }[];
    }>(`SELECT provider, oauth2_client_secret_enc, restrict_conditions
           FROM portal.login_config WHERE singleton`);
    expect(loginRows.rows[0]?.provider).toBe('oauth2');
    expect(loginRows.rows[0]?.restrict_conditions).toEqual([
      { field: 'schoolCode', path: '', value: '1001' },
      { field: 'schoolCode', path: '', value: '1002' },
    ]);
    expect(String(loginRows.rows[0]?.oauth2_client_secret_enc)).not.toContain(clientSecret);

    const stored = await readStoredConfig();
    expect(stored.app.schoolName).toBe('迁移测试学校');
    expect(stored.app.tencentPermissionIds).toEqual([1, 2, 3]);
    expect(stored.app.tencentSecretId).toBe(secretId);
    expect(stored.app.tencentSecretKey).toBe(secretKey);
    expect(stored.login.oauth2ClientSecret).toBe(clientSecret);
    expect(stored.login.restrictConditions).toEqual([
      { field: 'schoolCode', path: '', value: '1001' },
      { field: 'schoolCode', path: '', value: '1002' },
    ]);
    expect(stored.verify.tencent.status).toBe('failed');

    expect(await tableExists(db, LEGACY_APP_CONFIG_TABLE.split('.')[1])).toBe(false);
    expect(await tableExists(db, LEGACY_LOGIN_CONFIG_TABLE.split('.')[1])).toBe(false);
  });

  it('迁移标记存在时再次启动是空操作，不会重建 legacy 表', async () => {
    const db = getDb();
    await insertLegacy(db, 'app_config', FIELDS.schoolName.auditName, '第一次迁移');
    await ensurePortalSchema();

    resetPortalSchemaCache();
    await ensurePortalSchema();

    const rows = await db.query<{ school_name: string }>(
      'SELECT school_name FROM portal.app_config WHERE singleton'
    );
    expect(rows.rows[0]?.school_name).toBe('第一次迁移');
    expect(await tableExists(db, LEGACY_APP_CONFIG_TABLE.split('.')[1])).toBe(false);
  });
});
