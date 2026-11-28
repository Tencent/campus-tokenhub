/**
 * 门户自有表的建表与一次性迁移。
 *
 * 表都在同一个 Postgres 的 `portal` schema 下，与网关的 `octafuse_gateway.*` 隔离：
 * - `${OWN_SCHEMA}.activity_configs`：运营活动，一行一个活动（原来是一段 JSON 塞在网关 system_config）
 * - `${SHARED_SCHEMA}.admins`：全局管理员名单，一行一个身份（原来是逗号串）
 * - `portal.app_config`：首页与品牌 / 额度 / 成员凭据等通用运行期配置
 * - `portal.login_config`：登录认证配置（`auth.*`），从 `app_config` 拆出来的独立表
 * - `${SHARED_SCHEMA}.settings`：内部标记表，只记录「某份数据是否已迁移过」，不是业务数据，页面不展示
 *
 * DDL 在进程内只跑一次（`ensurePortalSchema`），用事务 + advisory lock 兜住并发启动。
 */

import {
  APP_CONFIG_TABLE,
  SETTINGS_TABLE,
  OWN_SCHEMA,
  SHARED_SCHEMA,
  LEGACY_APP_CONFIG_TABLE,
  LEGACY_LOGIN_CONFIG_TABLE,
  LOGIN_CONFIG_KEY_PREFIX,
  LOGIN_CONFIG_TABLE,
  STRUCTURED_MIGRATION_MARKER,
} from '@/lib/config/tables';
import {
  APP_FIELD_NAMES,
  FIELDS,
  LOGIN_FIELD_NAMES,
  fieldsForProbe,
  type ConfigField,
  type ProbeGroup,
} from '@/lib/config/fields';
import { ACTIVITY_OBSOLETE_INDEX_STATEMENTS } from '@campus/portal-activity';
import { SHARED_SCHEMA_STATEMENTS } from './shared-schema';
import { withTransaction, type Db } from './portal-db';

/** 建表锁：多个门户副本同时启动时，只有拿到锁的那个真正建表 */
const SCHEMA_LOCK_KEY = 'campus_tokenhub_schema_v1';

export const PORTAL_SCHEMA_STATEMENTS: readonly string[] = [
  // 共享层（portal_shared）的 DDL 抽在 shared-schema.ts：两侧逐字相同，改一处必须同步另一处
  ...SHARED_SCHEMA_STATEMENTS,
  `CREATE SCHEMA IF NOT EXISTS ${OWN_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${OWN_SCHEMA}.activity_configs (
     id          text PRIMARY KEY,
     title       text NOT NULL,
     points      integer NOT NULL,
     period      text NOT NULL,
     summary     jsonb NOT NULL DEFAULT '[]'::jsonb,
     badge       text,
     cta_label   text,
     starts_on   text,
     ends_on     text,
     weekdays    smallint[],
     closed_hint text,
     featured    boolean NOT NULL DEFAULT false,
     enabled     boolean NOT NULL DEFAULT true,
     sort_order  integer NOT NULL DEFAULT 0,
     created_at  timestamptz NOT NULL DEFAULT now(),
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
];

/**
 * 登录配置拆分迁移：把还留在 `app_config` 里的 `auth.*` 行搬进 `login_config`。
 *
 * 幂等：每次启动都会执行，搬完旧表里就没有这些行了，后续执行是空操作。
 * `ON CONFLICT ... DO UPDATE ... WHERE` 只在旧行更新时间更晚时覆盖新表，
 * 避免手工回填的旧值把新表里的新值盖掉；`RETURNING` 用来统计真实迁移条数。
 */
export const LOGIN_CONFIG_MIGRATION_SQL = `
  INSERT INTO ${LOGIN_CONFIG_TABLE} (
    key, value_plain, value_enc, is_secret, updated_by, updated_at,
    verify_status, verify_message, verified_at
  )
  SELECT key, value_plain, value_enc, is_secret, updated_by, updated_at,
         verify_status, verify_message, verified_at
    FROM ${APP_CONFIG_TABLE}
   WHERE key LIKE '${LOGIN_CONFIG_KEY_PREFIX}%'
  ON CONFLICT (key) DO UPDATE
    SET value_plain    = EXCLUDED.value_plain,
        value_enc      = EXCLUDED.value_enc,
        is_secret      = EXCLUDED.is_secret,
        updated_by     = EXCLUDED.updated_by,
        updated_at     = EXCLUDED.updated_at,
        verify_status  = EXCLUDED.verify_status,
        verify_message = EXCLUDED.verify_message,
        verified_at    = EXCLUDED.verified_at
    WHERE EXCLUDED.updated_at > ${LOGIN_CONFIG_TABLE}.updated_at
  RETURNING key
`;

/** 迁移后清掉旧表里的登录配置：保证同一份配置只存在于一张表，不会读串 */
export const LOGIN_CONFIG_CLEANUP_SQL =
  `DELETE FROM ${APP_CONFIG_TABLE} WHERE key LIKE '${LOGIN_CONFIG_KEY_PREFIX}%'`;

/** SQL 文本只由代码里的常量/描述符拼成，不接受外部输入 */
function sqlStringList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ');
}

/**
 * 登录限制条件的迁移表达式。
 *
 * 旧模型是「一个字段 + 多个允许值、任一命中」，新模型是「多条条件、且」：
 * 这里把每个允许值展开成一条独立条件（更严格，宁可拒绝也不静默放开）。
 */
function legacyConditionsExpression(legacyTable: string): string {
  const raw = (key: string) =>
    `(SELECT value_plain FROM ${legacyTable} WHERE key = ${sqlStringList([key])} LIMIT 1)`;
  const values = `CASE
      WHEN btrim(${raw('auth.restrict.allowedValues')}) LIKE '[%'
        THEN ${raw('auth.restrict.allowedValues')}::jsonb
      ELSE to_jsonb(string_to_array(coalesce(${raw('auth.restrict.allowedValues')}, ''), ','))
    END`;
  return `(SELECT jsonb_agg(jsonb_build_object(
             'field', coalesce(nullif(btrim(${raw('auth.restrict.field')}), ''), 'subject'),
             'path', coalesce(btrim(${raw('auth.restrict.customField')}), ''),
             'value', btrim(item)
           ) ORDER BY btrim(item))
           FILTER (WHERE btrim(item) <> '')
           FROM jsonb_array_elements_text(${values}) AS item)`;
}

/** 旧 EAV 表某个字段的取值表达式；密钥列取 value_enc，数组列从 JSON 文本转成 Postgres 数组 */
function legacyFieldExpression(field: ConfigField, legacyTable: string): string {
  const def = FIELDS[field];
  if (def.type === 'conditions') return legacyConditionsExpression(legacyTable);
  const key = sqlStringList([def.auditName]);
  if (def.secret) {
    return `(SELECT value_enc FROM ${legacyTable} WHERE key = ${key} LIMIT 1)`;
  }
  if (def.type === 'number[]' || def.type === 'string[]') {
    const cast = def.type === 'number[]' ? 'integer' : 'text';
    // 旧 EAV 里数组既可能是 '[1,2]'，也可能是逗号串 'a,b'，两种都兼容
    const raw = `(SELECT value_plain FROM ${legacyTable} WHERE key = ${key} LIMIT 1)`;
    const json = `CASE
        WHEN btrim(${raw}) LIKE '[%' THEN ${raw}::jsonb
        ELSE to_jsonb(string_to_array(coalesce(${raw}, ''), ','))
      END`;
    return `(SELECT coalesce(array_agg(btrim(item)::${cast}) FILTER (WHERE btrim(item) <> ''), '{}'::${cast}[])
               FROM jsonb_array_elements_text(${json}) AS item)`;
  }
  const raw = `max(value_plain) FILTER (WHERE key = ${key})`;
  if (def.type === 'number') return `(${raw})::integer`;
  if (def.type === 'boolean') return `(${raw})::boolean`;
  return raw;
}

/** 探测分组的验证状态：按组内最差项合并（failed > unverified > ok） */
function legacyVerifyExpressions(group: ProbeGroup): string[] {
  const keys = sqlStringList(fieldsForProbe(group).map((field) => FIELDS[field].auditName));
  const scoped = `FILTER (WHERE key IN (${keys}))`;
  return [
    `CASE
       WHEN count(*) ${scoped} = 0 THEN 'unverified'
       WHEN bool_or(verify_status = 'failed') ${scoped} THEN 'failed'
       WHEN bool_or(verify_status IS DISTINCT FROM 'ok') ${scoped} THEN 'unverified'
       ELSE 'ok'
     END`,
    `(max(verify_message) FILTER (WHERE key IN (${keys}) AND verify_status IS DISTINCT FROM 'ok'))`,
    `(max(verified_at) ${scoped})`,
  ];
}

function legacyInsertSql(
  table: string,
  legacyTable: string,
  fields: readonly ConfigField[],
  verifyGroups: readonly ProbeGroup[]
): string {
  const verifyColumns = verifyGroups.flatMap((group) => [
    `${group}_verify_status`,
    `${group}_verify_message`,
    `${group}_verified_at`,
  ]);
  const verifyExpressions = verifyGroups.flatMap((group) =>
    legacyVerifyExpressions(group)
  );
  const columns = [
    'singleton',
    ...fields.map((field) => FIELDS[field].column),
    ...verifyColumns,
    'updated_by',
    'updated_at',
  ];
  const values = [
    'true',
    ...fields.map((field) => legacyFieldExpression(field, legacyTable)),
    ...verifyExpressions,
    'max(updated_by)',
    'coalesce(max(updated_at), now())',
  ];
  return `INSERT INTO ${table} (${columns.join(', ')})\n  SELECT ${values.join(', ')}\n    FROM ${legacyTable}`;
}

/**
 * EAV → 结构化单行表的透视迁移 SQL（用描述符生成，避免列清单与代码漂移）。
 * 只在检测到旧表时执行；两批 SQL 与建表、DROP 在同一个事务里。
 */
export function buildStructuredConfigMigrationSql(): { app: string; login: string } {
  return {
    app: legacyInsertSql(
      APP_CONFIG_TABLE,
      LEGACY_APP_CONFIG_TABLE,
      APP_FIELD_NAMES,
      ['currency']
    ),
    login: legacyInsertSql(
      LOGIN_CONFIG_TABLE,
      LEGACY_LOGIN_CONFIG_TABLE,
      LOGIN_FIELD_NAMES,
      []
    ),
  };
}

/** 用 information_schema 判断表是否还是旧 EAV 形态（有 key 列） */
async function isEavTable(db: Db, table: string): Promise<boolean> {
  const [schemaName, tableName] = table.split('.');
  const { rows } = await db.query<{ hasKey: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 AND column_name = 'key'
     ) AS "hasKey"`,
    [schemaName, tableName]
  );
  return Boolean(rows[0]?.hasKey);
}

let ready: Promise<void> | null = null;

/**
 * 确保门户自己的 schema 与表存在。
 *
 * 失败时清掉缓存的 Promise，下次调用重试（数据库晚于门户起来是常见情况）。
 */
export function ensurePortalSchema(): Promise<void> {
  if (!ready) {
    ready = createSchema().catch((error: unknown) => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

async function createSchema(): Promise<void> {
  await withTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SCHEMA_LOCK_KEY]);

    // 先跑一次 DDL：settings / config_audit 等表必须存在才能读写迁移标记。
    // CREATE TABLE IF NOT EXISTS 对已有的 EAV 配置表是空操作，改名后会再跑一次建新表。
    for (const sql of PORTAL_SCHEMA_STATEMENTS) await db.query(sql);
    // 废弃索引清理必须放在迁移标记的提前返回之前：老库早已打过标记，
    // 放到后面就永远跑不到，那个索引会一直留着继续吃写入。
    for (const sql of ACTIVITY_OBSOLETE_INDEX_STATEMENTS) await db.query(sql);
    if (await readSetting(db, STRUCTURED_MIGRATION_MARKER)) return;

    const [appEav, loginEav] = await Promise.all([
      isEavTable(db, APP_CONFIG_TABLE),
      isEavTable(db, LOGIN_CONFIG_TABLE),
    ]);

    // 更早的版本把 auth.* 混在 app_config 里，先做一次拆分再透视成结构化列。
    if (appEav && loginEav) {
      await db.query(LOGIN_CONFIG_MIGRATION_SQL);
      await db.query(LOGIN_CONFIG_CLEANUP_SQL);
    }

    // PostgreSQL 的 RENAME TO 只接受表名，不接受 schema 限定名
    if (appEav) await db.query(`ALTER TABLE ${APP_CONFIG_TABLE} RENAME TO ${LEGACY_APP_CONFIG_TABLE.split('.')[1]}`);
    if (loginEav) {
      await db.query(`ALTER TABLE ${LOGIN_CONFIG_TABLE} RENAME TO ${LEGACY_LOGIN_CONFIG_TABLE.split('.')[1]}`);
    }

    if (appEav || loginEav) {
      for (const sql of PORTAL_SCHEMA_STATEMENTS) await db.query(sql);
    }

    const migration = buildStructuredConfigMigrationSql();
    if (appEav) {
      await db.query(migration.app);
      await db.query(`DROP TABLE ${LEGACY_APP_CONFIG_TABLE}`);
      console.info(`[portal-schema] 已把通用配置迁移到 ${APP_CONFIG_TABLE} 的结构化列`);
    }
    if (loginEav) {
      await db.query(migration.login);
      await db.query(`DROP TABLE ${LEGACY_LOGIN_CONFIG_TABLE}`);
      console.info(`[portal-schema] 已把登录配置迁移到 ${LOGIN_CONFIG_TABLE} 的结构化列`);
    }

    await writeSetting(db, STRUCTURED_MIGRATION_MARKER, new Date().toISOString());
  });
}

/** 测试用：忘掉「已建表」状态 */
export function resetPortalSchemaCache(): void {
  ready = null;
}

/** 单个键的标记（内部迁移用）。 */
export async function readSetting(db: Db, key: string): Promise<string | null> {
  // ⚠️ 必须用模板字符串：单引号里 `${...}` 不会插值，PG 会在 `$` 处报语法错误
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM ${SETTINGS_TABLE} WHERE key = $1`,
    [key]
  );
  return rows[0]?.value ?? null;
}

export async function writeSetting(db: Db, key: string, value: string): Promise<void> {
  await db.query(
    `INSERT INTO ${SHARED_SCHEMA}.settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}
