import {
  APP_FIELD_NAMES,
  FIELDS,
  LOGIN_FIELD_NAMES,
  type ConfigField,
  type ConfigValue,
  type ProbeGroup,
} from '@/lib/config/fields';
import type {
  ConfigAuditEntry,
  ConfigRepo,
  FieldWrite,
  RawConfigRow,
  StoredConfig,
  VerifyState,
} from '@/lib/config/store';

type VerifyOverrides = Partial<Record<ProbeGroup, Partial<VerifyState>>>;

function emptyVerify(group: ProbeGroup): VerifyState {
  return { group, status: 'unverified', message: null, verifiedAt: null };
}

/** 按类型化字段构造结构化配置；未给出的字段全部是 NULL（回落 env/默认值） */
export function storedConfig(
  values: Partial<Record<ConfigField, ConfigValue>> = {},
  options: { verify?: VerifyOverrides; brokenFields?: ConfigField[]; secretPlaintexts?: string[] } = {}
): StoredConfig {
  const app: Record<string, unknown> = {};
  for (const field of APP_FIELD_NAMES) app[field] = values[field] ?? null;
  const login: Record<string, unknown> = {};
  for (const field of LOGIN_FIELD_NAMES) login[field] = values[field] ?? null;

  const secretPlaintexts = options.secretPlaintexts ?? [];
  for (const field of ['oauth2ClientSecret'] as const) {
    const value = values[field];
    if (typeof value === 'string' && value && !secretPlaintexts.includes(value)) {
      secretPlaintexts.push(value);
    }
  }

  return {
    app: app as StoredConfig['app'],
    login: login as StoredConfig['login'],
    verify: {
      currency: { ...emptyVerify('currency'), ...options.verify?.currency },
    },
    brokenFields: options.brokenFields ?? [],
    secretPlaintexts,
    updatedBy: null,
  };
}

/** 把写入值还原成 DB 行里的形状（数组 / 条件用原生数组，密钥用密文字节） */
function rawFromWrite(field: ConfigField, write: FieldWrite): ConfigValue | Buffer | null {
  if (write.enc) return write.enc;
  const type = FIELDS[field].type;
  if (type === 'string[]' || type === 'number[]' || type === 'conditions') {
    return JSON.parse(write.plain ?? '[]') as ConfigValue;
  }
  if (type === 'number') return Number(write.plain);
  if (type === 'boolean') return write.plain === 'true';
  return write.plain;
}

export type MemoryConfigState = {
  values: Partial<Record<ConfigField, ConfigValue | Buffer | null>>;
  verify: Record<ProbeGroup, VerifyState>;
  audits: ConfigAuditEntry[];
  calls: { write: number; clear: number; audit: number; verify: number };
};

/** 内存版结构化仓库：只验证编排逻辑，SQL 由真实 Postgres 集成测试覆盖 */
export function memoryConfigRepo(
  values: Partial<Record<ConfigField, ConfigValue | Buffer | null>> = {}
): { repo: ConfigRepo; state: MemoryConfigState } {
  const state: MemoryConfigState = {
    values: { ...values },
    verify: { currency: emptyVerify('currency') },
    audits: [],
    calls: { write: 0, clear: 0, audit: 0, verify: 0 },
  };

  const repo: ConfigRepo = {
    async read(): Promise<RawConfigRow> {
      return {
        values: { ...state.values },
        verify: {
          currency: { ...state.verify.currency },
        },
        updatedBy: null,
      };
    },
    async write(writes: FieldWrite[]) {
      state.calls.write += 1;
      for (const write of writes) state.values[write.field] = rawFromWrite(write.field, write);
    },
    async seedIfEmpty(writes: FieldWrite[]) {
      // 真实库用条件 UPDATE 兜并发；内存版单线程，读-判-写即可
      if (state.values.localAdminPassword != null) return false;
      if (state.values.localAdminMode === 'off') return false;
      state.calls.write += 1;
      for (const write of writes) state.values[write.field] = rawFromWrite(write.field, write);
      return true;
    },
    async clear(fields: ConfigField[]) {
      state.calls.clear += 1;
      for (const field of fields) state.values[field] = null;
    },
    async insertAudit(entries: ConfigAuditEntry[]) {
      state.calls.audit += 1;
      state.audits.push(...entries);
    },
    async setVerify(group: ProbeGroup, next: Omit<VerifyState, 'group'>) {
      state.calls.verify += 1;
      state.verify[group] = { group, ...next };
    },
    async transaction<T>(fn: (tx: ConfigRepo) => Promise<T>): Promise<T> {
      return fn(repo);
    },
  };

  return { repo, state };
}
