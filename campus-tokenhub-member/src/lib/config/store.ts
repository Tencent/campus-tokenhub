/**
 * 运行期配置的存储层（结构化单行表）。
 *
 * - 校验：字段 id + 描述符校验后整批转换，非法值在写库前拒绝；
 * - 加密：密钥只在内存里明文，落库只写 `*_enc` 字节列；
 * - 事务：写入 + 清除 + 审计在同一事务里提交；
 * - 降级：单个字段解密/解析失败只置空并计入 `brokenFields`，不影响整页配置。
 *
 * SQL 只出现在 `createPgConfigRepo()`，列名全部来自 `fields.ts` 描述符白名单；
 * 上层只认识类型化字段 id，不再有 `auth.*` 之类的字符串 key。
 */

import { getDb, withTransaction, type Db } from '@/lib/db/portal-db';
import {
  APP_CONFIG_TABLE,
  CONFIG_AUDIT_TABLE,
  LOGIN_CONFIG_TABLE,
} from './tables';
import { decryptConfigValue, encryptConfigValue } from './crypto';
import {
  APP_FIELD_NAMES,
  CONFIG_FIELD_NAMES,
  FIELDS,
  LOGIN_FIELD_NAMES,
  ConfigValueError,
  deserializeFieldValue,
  emptyStoredValues,
  fieldsForProbe,
  serializeFieldValue,
  toConfigValue,
  type ConfigField,
  type ConfigValue,
  type ProbeGroup,
  type RestrictCondition,
  type StoredAppConfig,
  type StoredLoginConfig,
} from './fields';

export class ConfigStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigStoreError';
  }
}

export type VerifyStatus = 'ok' | 'failed' | 'unverified';

export type VerifyState = {
  group: ProbeGroup;
  status: VerifyStatus;
  message: string | null;
  verifiedAt: string | null;
};

export type StoredConfig = {
  app: StoredAppConfig;
  login: StoredLoginConfig;
  verify: Record<ProbeGroup, VerifyState>;
  /** 解密 / 解析失败的字段，读取时按未配置处理 */
  brokenFields: ConfigField[];
  /** 密钥明文，仅供日志脱敏使用，禁止下发 */
  secretPlaintexts: string[];
  updatedBy: string | null;
};

export type ConfigAuditEntry = {
  key: string;
  action: 'set' | 'clear';
  valueHint: string | null;
  actorSub: string | null;
  actorIp: string | null;
};

/** 数据库原始行：密钥是 Buffer 密文，其余是与列对应的标量 / 数组 */
export type RawConfigRow = {
  values: Partial<Record<ConfigField, ConfigValue | Buffer | null>>;
  verify: Record<ProbeGroup, VerifyState>;
  updatedBy: string | null;
};

export type FieldWrite = {
  field: ConfigField;
  /** 非密钥字段的序列化值；清除时由 repo.clear 处理 */
  plain: string | null;
  /** 密钥字段的密文字节 */
  enc: Buffer | null;
};

export type ConfigRepo = {
  read(): Promise<RawConfigRow>;
  write(writes: FieldWrite[]): Promise<void>;
  clear(fields: ConfigField[]): Promise<void>;
  insertAudit(entries: ConfigAuditEntry[]): Promise<void>;
  setVerify(group: ProbeGroup, state: Omit<VerifyState, 'group'>): Promise<void>;
  transaction<T>(fn: (repo: ConfigRepo) => Promise<T>): Promise<T>;
  /**
   * 首次种子：**仅当共享层里还没有部署管理员口令时**写入，返回是否真的写进去了。
   *
   * 双站同域部署时两站共用 `portal_shared.login_config` 单行，靠这条条件写保证
   * 「先启动的一侧把 env 写进去，另一侧读到同一行」——谁也不会覆盖谁。
   */
  seedIfEmpty(writes: FieldWrite[]): Promise<boolean>;
};

export type WriteConfigInput = {
  values: Partial<Record<ConfigField, unknown>>;
  clear?: ConfigField[];
  actorSub?: string | null;
  actorIp?: string | null;
};

const HINT_MAX = 40;

function hintOf(field: ConfigField, value: ConfigValue): string {
  const def = FIELDS[field];
  const text = def.type === 'conditions' && Array.isArray(value)
    ? (value as RestrictCondition[])
      .map((item) => `${item.field === 'custom' ? item.path : item.field}=${item.value}`)
      .join(' & ')
    : Array.isArray(value) ? value.join(',') : String(value);
  if (def.secret) {
    const tail = text.slice(-4);
    return tail ? `…${tail}` : '***';
  }
  return text.length > HINT_MAX ? `${text.slice(0, HINT_MAX)}…` : text;
}

function emptyVerify(group: ProbeGroup): VerifyState {
  return { group, status: 'unverified', message: null, verifiedAt: null };
}

/** 空的结构化配置：所有字段 NULL = 完全回落 env / 默认值 */
export function emptyStoredConfig(): StoredConfig {
  return {
    ...emptyStoredValues(),
    verify: { tencent: emptyVerify('tencent'), currency: emptyVerify('currency') },
    brokenFields: [],
    secretPlaintexts: [],
    updatedBy: null,
  };
}

function normalizeVerify(
  group: ProbeGroup,
  state: VerifyState | undefined
): VerifyState {
  if (!state) return emptyVerify(group);
  const status: VerifyStatus =
    state.status === 'ok' || state.status === 'failed' || state.status === 'unverified'
      ? state.status
      : 'unverified';
  return {
    group,
    status,
    message: state.message ?? null,
    verifiedAt: state.verifiedAt ?? null,
  };
}

/** 只有探测分组参与状态统计；组内任一字段损坏直接按 failed */
export function groupStatus(stored: StoredConfig, group: ProbeGroup): VerifyStatus {
  if (fieldsForProbe(group).some((field) => stored.brokenFields.includes(field))) {
    return 'failed';
  }
  return stored.verify[group]?.status ?? 'unverified';
}

/** 从结构化配置里按字段 id 取值；设置页回显不用再拼 `auth.*` 字符串 */
export function storedValue(
  stored: StoredConfig,
  field: ConfigField
): ConfigValue | null {
  const values: Record<string, unknown> =
    FIELDS[field].section === 'app' ? stored.app : stored.login;
  return (values[field] as ConfigValue | null) ?? null;
}

/** 把数据库列映射回类型化字段 id（列名只来自描述符） */
function rawFromRow(
  row: Record<string, unknown> | undefined,
  fields: readonly ConfigField[]
): Partial<Record<ConfigField, ConfigValue | Buffer | null>> {
  const values: Partial<Record<ConfigField, ConfigValue | Buffer | null>> = {};
  for (const field of fields) {
    values[field] = (row?.[FIELDS[field].column] as ConfigValue | Buffer | null) ?? null;
  }
  return values;
}

function verifyFromRow(row: Record<string, unknown> | undefined): Record<ProbeGroup, VerifyState> {
  const result = {} as Record<ProbeGroup, VerifyState>;
  for (const group of ['tencent', 'currency'] as const) {
    result[group] = {
      group,
      status: (row?.[`${group}_verify_status`] as VerifyStatus) ?? 'unverified',
      message: (row?.[`${group}_verify_message`] as string | null) ?? null,
      verifiedAt: row?.[`${group}_verified_at`]
        ? new Date(row[`${group}_verified_at`] as string | Date).toISOString()
        : null,
    };
  }
  return result;
}

type DbRow = Record<string, unknown>;

function dbValue(field: ConfigField, write: FieldWrite): unknown {
  if (write.enc) return write.enc;
  const type = FIELDS[field].type;
  if (type === 'string[]' || type === 'number[]') {
    return JSON.parse(write.plain ?? '[]') as string[] | number[];
  }
  // jsonb 列：node-postgres 会把 JS 数组当成 Postgres 数组字面量，必须显式给 JSON 文本
  if (type === 'conditions') return JSON.stringify(JSON.parse(write.plain ?? '[]'));
  if (type === 'number') return Number(write.plain);
  if (type === 'boolean') return write.plain === 'true';
  return write.plain;
}

/** 只按 section 分组写同一张表；列名由描述符提供，值全部走占位符 */
async function writeRows(db: Db, writes: FieldWrite[], actorSub: string | null): Promise<void> {
  for (const section of ['app', 'login'] as const) {
    const rows = writes.filter((write) => FIELDS[write.field].section === section);
    if (rows.length === 0) continue;
    const table = section === 'app' ? APP_CONFIG_TABLE : LOGIN_CONFIG_TABLE;
    await db.query(`INSERT INTO ${table} (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`);
    const assignments = rows.map(
      (write, index) => `${FIELDS[write.field].column} = $${index + 1}`
    );
    assignments.push(`updated_by = $${rows.length + 1}`, 'updated_at = now()');
    await db.query(
      `UPDATE ${table} SET ${assignments.join(', ')} WHERE singleton`,
      [...rows.map((write) => dbValue(write.field, write)), actorSub]
    );
  }
}

async function clearRows(db: Db, fields: ConfigField[]): Promise<void> {
  for (const section of ['app', 'login'] as const) {
    const names = fields.filter((field) => FIELDS[field].section === section);
    if (names.length === 0) continue;
    const table = section === 'app' ? APP_CONFIG_TABLE : LOGIN_CONFIG_TABLE;
    // 没有行时 UPDATE 是空操作；后续读取回落 env / 默认值
    await db.query(
      `UPDATE ${table} SET ${names.map((field) => `${FIELDS[field].column} = NULL`).join(', ')},
        updated_at = now() WHERE singleton`
    );
  }
}

export function createPgConfigRepo(db: Db): ConfigRepo {
  return {
    async read() {
      const [appRows, loginRows] = await Promise.all([
        db.query<DbRow>(`SELECT * FROM ${APP_CONFIG_TABLE} LIMIT 1`),
        db.query<DbRow>(`SELECT * FROM ${LOGIN_CONFIG_TABLE} LIMIT 1`),
      ]);
      const app = appRows.rows[0];
      return {
        values: {
          ...rawFromRow(app, APP_FIELD_NAMES),
          ...rawFromRow(loginRows.rows[0], LOGIN_FIELD_NAMES),
        },
        verify: verifyFromRow(app),
        updatedBy: (app?.updated_by as string | null) ?? null,
      };
    },

    async write(writes: FieldWrite[]) {
      await writeRows(db, writes, null);
    },

    async seedIfEmpty(writes: FieldWrite[]) {
      const rows = writes.filter((write) => FIELDS[write.field].section === 'login');
      // 只对部署管理员凭据这一组做条件写；其它字段没有「先到先得」的语义
      if (!rows.some((write) => write.field === 'localAdminPassword')) return false;

      await db.query(
        `INSERT INTO ${LOGIN_CONFIG_TABLE} (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`
      );
      const params: unknown[] = rows.map((write) => dbValue(write.field, write));
      const assignments = rows.map(
        (write, index) => `${FIELDS[write.field].column} = $${index + 1}`
      );
      assignments.push(`updated_by = $${params.length + 1}`, 'updated_at = now()');
      params.push(LOCAL_ADMIN_SEED_ACTOR);

      // 两道 guard：
      //   1. 口令列仍为空 —— 还没人配过（另一侧没有先写）；
      //   2. 开关不是 off —— 运维已显式关过这条通道，重启不该把它从 .env 里「复活」。
      // RETURNING 有行 = 本次写入生效；0 行 = 条件不满足，本次什么都不改。
      const sql = `UPDATE ${LOGIN_CONFIG_TABLE} SET ${assignments.join(', ')}
                    WHERE singleton
                      AND ${FIELDS.localAdminPassword.column} IS NULL
                      AND COALESCE(${FIELDS.localAdminMode.column}, 'auto') <> 'off'
                RETURNING singleton`;
      const result = await db.query(sql, params);
      return result.rows.length > 0;
    },

    async clear(fields: ConfigField[]) {
      await clearRows(db, fields);
    },

    async setVerify(group, state) {
      await db.query(
        `INSERT INTO ${APP_CONFIG_TABLE} (singleton) VALUES (true) ON CONFLICT (singleton) DO NOTHING`
      );
      await db.query(
        `UPDATE ${APP_CONFIG_TABLE}
            SET ${group}_verify_status = $1,
                ${group}_verify_message = $2,
                ${group}_verified_at = $3
          WHERE singleton`,
        [state.status, state.message, state.verifiedAt]
      );
    },

    async insertAudit(entries: ConfigAuditEntry[]) {
      for (const entry of entries) {
        await db.query(
          `INSERT INTO ${CONFIG_AUDIT_TABLE} (key, action, value_hint, actor_sub, actor_ip)
           VALUES ($1, $2, $3, $4, $5)`,
          [entry.key, entry.action, entry.valueHint, entry.actorSub, entry.actorIp]
        );
      }
    },

    async transaction<T>(fn: (repo: ConfigRepo) => Promise<T>): Promise<T> {
      return withTransaction(async (tx) => fn(createPgConfigRepo(tx)));
    },
  };
}

let defaultRepo: ConfigRepo | null = null;
let repoOverride: ConfigRepo | null = null;

export function setConfigRepoOverride(repo: ConfigRepo | null): void {
  repoOverride = repo;
  defaultRepo = null;
}

/** 测试注入的仓库存在时，不需要真实数据库连接串也能读配置。 */
export function hasConfigRepoOverride(): boolean {
  return repoOverride !== null;
}

function repoOrDefault(repo?: ConfigRepo): ConfigRepo {
  if (repo) return repo;
  if (repoOverride) return repoOverride;
  if (!defaultRepo) defaultRepo = createPgConfigRepo(getDb());
  return defaultRepo;
}

export function resetConfigStoreCache(): void {
  defaultRepo = null;
  repoOverride = null;
}

/** 读取并还原全部配置；单字段失败只降级该字段 */
export async function readStoredConfig(repo?: ConfigRepo): Promise<StoredConfig> {
  const raw = await repoOrDefault(repo).read();
  const values: Partial<Record<ConfigField, ConfigValue | null>> = {};
  const brokenFields: ConfigField[] = [];
  const secretPlaintexts: string[] = [];

  for (const field of CONFIG_FIELD_NAMES) {
    const def = FIELDS[field];
    const rawValue = raw.values[field];
    if (rawValue === undefined || rawValue === null) {
      values[field] = null;
      continue;
    }
    try {
      let value: ConfigValue;
      if (def.secret) {
        if (!Buffer.isBuffer(rawValue) && typeof rawValue !== 'string') {
          throw new Error('缺少密文');
        }
        const payload = Buffer.isBuffer(rawValue) ? rawValue.toString('utf8') : rawValue;
        const plain = decryptConfigValue(payload, def.cryptoKey ?? def.auditName);
        value = toConfigValue(field, plain);
        secretPlaintexts.push(plain);
      } else if (Array.isArray(rawValue)) {
        value = toConfigValue(field, rawValue);
      } else if (typeof rawValue === 'string' && (def.type === 'string[]' || def.type === 'number[]')) {
        value = deserializeFieldValue(field, rawValue);
      } else {
        value = toConfigValue(field, rawValue);
      }
      values[field] = value;
    } catch {
      values[field] = null;
      brokenFields.push(field);
    }
  }

  const app: Record<string, unknown> = {};
  for (const field of APP_FIELD_NAMES) app[field] = values[field] ?? null;
  const login: Record<string, unknown> = {};
  for (const field of LOGIN_FIELD_NAMES) login[field] = values[field] ?? null;

  return {
    app: app as StoredAppConfig,
    login: login as StoredLoginConfig,
    verify: {
      tencent: normalizeVerify('tencent', raw.verify?.tencent),
      currency: normalizeVerify('currency', raw.verify?.currency),
    },
    brokenFields,
    secretPlaintexts,
    updatedBy: raw.updatedBy ?? null,
  };
}

/** 纯校验 + 组装，不碰数据库 */
function prepareWrites(input: WriteConfigInput): {
  writes: FieldWrite[];
  audits: ConfigAuditEntry[];
} {
  const writes: FieldWrite[] = [];
  const audits: ConfigAuditEntry[] = [];

  for (const [field, raw] of Object.entries(input.values ?? {}) as [ConfigField, unknown][]) {
    const def = FIELDS[field];
    if (!def) throw new ConfigStoreError(`未注册的配置字段：${field}`);

    let value: ConfigValue;
    try {
      value = toConfigValue(field, raw);
    } catch (error) {
      if (error instanceof ConfigValueError) throw new ConfigStoreError(error.message);
      throw error;
    }
    if (def.secret && typeof value === 'string' && !value) {
      throw new ConfigStoreError(`${def.label} 不能为空；如需清除请使用清除操作`);
    }

    writes.push({
      field,
      plain: def.secret ? null : serializeFieldValue(field, value),
      enc: def.secret
        ? Buffer.from(encryptConfigValue(String(value), def.cryptoKey ?? def.auditName), 'utf8')
        : null,
    });
    audits.push({
      key: def.auditName,
      action: 'set',
      valueHint: hintOf(field, value),
      actorSub: input.actorSub ?? null,
      actorIp: input.actorIp ?? null,
    });
  }

  return { writes, audits };
}

function assertFields(fields: readonly ConfigField[]): void {
  for (const field of fields) {
    if (!FIELDS[field]) throw new ConfigStoreError(`未注册的配置字段：${field}`);
  }
}

async function commitChanges(
  input: WriteConfigInput,
  repo?: ConfigRepo
): Promise<void> {
  const { writes, audits } = prepareWrites(input);
  const clear = [...new Set(input.clear ?? [])];
  assertFields(clear);
  if (writes.length === 0 && clear.length === 0) return;

  const target = repoOrDefault(repo);
  const run = async (tx: ConfigRepo): Promise<void> => {
    if (writes.length > 0) await tx.write(writes);
    if (clear.length > 0) await tx.clear(clear);
    for (const field of clear) {
      audits.push({
        key: FIELDS[field].auditName,
        action: 'clear',
        valueHint: null,
        actorSub: input.actorSub ?? null,
        actorIp: input.actorIp ?? null,
      });
    }
  };

  if (target.transaction) await target.transaction(run);
  else await run(target);

  // 审计在事务提交**之后**单独写：曾经把它放进同一个事务，一旦审计 INSERT 报错
  // （比如表名指向了不存在的 schema），整个事务回滚，接口照样回 `{ ok: true }`，
  // 表现就是「保存成功但配置没变」。审计是旁路记录，失败只能降级为日志。
  await writeAudit(target, audits);
}

/** 首次种子写入的审计署名：与人工操作区分开 */
export const LOCAL_ADMIN_SEED_ACTOR = 'system:local-admin-seed';

/**
 * 把部署管理员凭据写进共享配置——**只在库内还是空的时候**。
 *
 * 为什么需要它：两站的「账号密码登录」凭据只来自各自的容器环境变量，
 * 而账号是否能登进去只看本侧 .env；给某一站单独配一套就会出现
 * 「采采买站能登、成员站登不进」而两边容器都 healthy 的悬案。
 * 让共享库当唯一权威（首次启动把 env 种进去，之后改 .env 不再生效），
 * 同库双站部署下两站读的是同一行，口径天然一致。
 *
 * 返回 true 表示这次真的写进去了（本侧是「先到的那一侧」），false 表示库内已有值、本次不动。
 * 审计照常写，actor 用 `system:local-admin-seed` 标明是启动期自动写入而非人为保存。
 */
export async function seedLocalAdminCredentialIfEmpty(
  username: string,
  password: string,
  repo?: ConfigRepo
): Promise<boolean> {
  const { writes, audits } = prepareWrites({
    values: { localAdminUsername: username, localAdminPassword: password },
    actorSub: LOCAL_ADMIN_SEED_ACTOR,
  });
  const target = repoOrDefault(repo);
  const seeded = await target.seedIfEmpty(writes);
  if (!seeded) return false;
  await writeAudit(target, audits);
  return true;
}

/** 写入单个 / 多个字段（不清空未提交的字段） */
export async function writeConfigEntries(input: WriteConfigInput, repo?: ConfigRepo): Promise<void> {
  await commitChanges(input, repo);
}

/** 一次提交里同时写入与清除（二者在同一事务） */
export async function applyConfigChanges(input: WriteConfigInput, repo?: ConfigRepo): Promise<void> {
  await commitChanges(input, repo);
}

/** 清除单个字段（等价于把列置 NULL，读取时回落 env / 默认值） */
export async function clearConfigEntry(
  field: ConfigField,
  repo?: ConfigRepo,
  actor: { sub?: string | null; ip?: string | null } = {}
): Promise<void> {
  assertFields([field]);
  const target = repoOrDefault(repo);
  const run = async (tx: ConfigRepo): Promise<void> => {
    await tx.clear([field]);
  };
  if (target.transaction) await target.transaction(run);
  else await run(target);

  // 与 commitChanges 同理：审计失败不能让清除动作回滚
  await writeAudit(target, [
    {
      key: FIELDS[field].auditName,
      action: 'clear',
      valueHint: null,
      actorSub: actor.sub ?? null,
      actorIp: actor.ip ?? null,
    },
  ]);
}

/** 审计失败不影响配置生效：只打日志 */
async function writeAudit(target: ConfigRepo, audits: ConfigAuditEntry[]): Promise<void> {
  if (audits.length === 0) return;
  try {
    await target.insertAudit(audits);
  } catch (error) {
    // 配置已生效，审计丢了：日志里留下完整条目，事后可按日志补录
    console.warn(
      `[config] 审计写入失败（配置已生效）：${error instanceof Error ? error.message : String(error)}`,
      audits.map((entry) => `${entry.key}:${entry.action}`)
    );
  }
}

/** 写分组验证状态；失败只 warn，不影响配置本身 */
export async function setVerifyState(
  group: ProbeGroup,
  status: VerifyStatus,
  message: string | null,
  repo?: ConfigRepo
): Promise<void> {
  try {
    await repoOrDefault(repo).setVerify(group, {
      status,
      message: message ? message.slice(0, 200) : null,
      verifiedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn(
      `[config] 验证状态写入失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
}
