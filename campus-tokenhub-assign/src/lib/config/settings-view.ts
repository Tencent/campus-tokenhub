/**
 * 设置页与接口共用的「当前配置视图」。
 *
 * 页面（服务端渲染）与 `GET /api/portal/settings` 必须看到同一份数据：
 * 非敏感项给原值，敏感项只给「是否已配置 + 尾号」。
 *
 * 所有 key 都是 `fields.ts` 的字段 id 联合类型，不再有 `auth.*` / `portal.*` 动态字符串。
 */

import {
  CONFIG_FIELD_NAMES,
  LOGIN_FIELD_NAMES,
  SECRET_FIELD_NAMES,
  FIELDS,
  fieldsForProbe,
  type ConfigField,
  type ConfigValue,
  type ProbeGroup,
  type SettingsGroup,
} from './fields';
import { brandLogoUrl } from './logo-url';
import {
  groupStatus as readProbeGroupStatus,
  readStoredConfig,
  storedValue,
  type VerifyStatus,
} from './store';
import { readLoginField } from './overlay';

export type SettingsSecretState = {
  configured: boolean;
  /** 只回显尾号（≤4 位） */
  hint: string;
  /** 明文长度；未配置为 0 */
  length: number;
};

export type SettingsPayload = {
  /** 显式存进配置表的值（保存时只提交改动过的字段） */
  values: Partial<Record<ConfigField, ConfigValue>>;
  /**
   * 当前生效值 = 配置表覆盖 + env/默认值。
   * 页面回显必须用它：否则「额度周期」这类有默认值的项会显示成空。
   */
  effective: Partial<Record<ConfigField, ConfigValue>>;
  secrets: Partial<Record<ConfigField, SettingsSecretState>>;
  brokenFields: ConfigField[];
  /** 已配置 Logo 时的读取地址；为空表示未配置 */
  logoUrl: string;
  /** 网关侧正文留存（只读：网关逐请求读环境变量，门户改不动） */
  retention: { capture: string; retentionDays: string; maxChars: string };
  /** 只包含有探测手段的 tab：首页配置 / 登录认证没有外部系统可校验 */
  groupStatus: Partial<Record<SettingsGroup, VerifyStatus>>;
};

/** 设置页 tab 对应的探测分组；没有映射的 tab 不参与徽标状态 */
const SETTINGS_PROBE_GROUP: Partial<Record<SettingsGroup, ProbeGroup>> = {
  quota: 'currency',
};

/** 分组参与状态统计的字段：只认描述符标了 probeGroup 的字段 */
export function groupStatusKeys(group: SettingsGroup): readonly ConfigField[] {
  const probeGroup = SETTINGS_PROBE_GROUP[group];
  return probeGroup ? fieldsForProbe(probeGroup) : [];
}

function hintOfSecret(plain: string): string {
  // 长度 ≤ 4 时「尾号」等于全部明文，只能给固定占位
  if (plain.length <= 4) return '***';
  return `…${plain.slice(-4)}`;
}

/** 敏感值的对外状态：只给「是否已配置 + 尾号 + 长度」，任何路径都不得回显明文 */
function secretState(plain: string): SettingsSecretState {
  if (!plain) return { configured: false, hint: '', length: 0 };
  return { configured: true, hint: hintOfSecret(plain), length: plain.length };
}

function retentionState() {
  return {
    capture: (process.env.REQUEST_CONTENT_CAPTURE ?? 'on').trim() || 'on',
    retentionDays: (process.env.REQUEST_CONTENT_RETENTION_DAYS ?? '90').trim() || '90',
    maxChars: (process.env.REQUEST_CONTENT_MAX_CHARS ?? '65536').trim() || '65536',
  };
}

/**
 * 当前生效值：配置表覆盖 + env/默认值。
 * 只用于页面回显，不写库。
 */
async function effectiveValues(): Promise<{
  values: Partial<Record<ConfigField, ConfigValue>>;
  secrets: Partial<Record<ConfigField, SettingsSecretState>>;
}> {
  const { getConfig } = await import('@/lib/config');
  const cfg = getConfig();
  const values: Partial<Record<ConfigField, ConfigValue>> = {
    schoolName: cfg.portal.schoolName,
    loginTitle: cfg.portal.loginTitle,
    loginSubtitle: cfg.portal.loginSubtitle,
    footerContact: cfg.portal.footerContact,
    brandColor: cfg.portal.brandColor,
    defaultBudgetMax: cfg.defaults.budgetMax,
    defaultBudgetPeriod: cfg.defaults.budgetPeriod,
  };
  // null 表示「未配置」，不放进 effective（与其它可空字段一致，UI 显示为空）
  if (cfg.defaults.rateLimitRpm !== null) values.defaultRateLimitRpm = cfg.defaults.rateLimitRpm;
  if (cfg.defaults.rateLimitTpm !== null) values.defaultRateLimitTpm = cfg.defaults.rateLimitTpm;

  for (const field of LOGIN_FIELD_NAMES) {
    // 密钥只通过 secrets 回显状态，绝不进入 effective（曾在这里泄露过明文）
    if (FIELDS[field].secret) continue;
    // 部署管理员在 portal.localAdmin 上，不在 auth 子树里，readLoginField 取不到
    if (field === 'localAdminMode') {
      values[field] = cfg.portal.localAdmin.mode;
      continue;
    }
    if (field === 'localAdminUsername') {
      values[field] = cfg.portal.localAdmin.username;
      continue;
    }
    const value = readLoginField(cfg.auth, field);
    if (value !== undefined) values[field] = value;
  }

  const secrets: Partial<Record<ConfigField, SettingsSecretState>> = {};
  for (const field of SECRET_FIELD_NAMES) {
    const plain =
      field === 'oauth2ClientSecret'
        ? cfg.auth.oauth2.clientSecret
        : field === 'wecomClientSecret'
          ? cfg.auth.wecom.secret
          : field === 'localAdminPassword'
            ? cfg.portal.localAdmin.password
            : '';
    secrets[field] = secretState(plain);
  }

  return { values, secrets };
}

export async function loadSettingsPayload(): Promise<SettingsPayload> {
  const [stored, effective] = await Promise.all([
    readStoredConfig(),
    effectiveValues(),
  ]);
  const values: Partial<Record<ConfigField, ConfigValue>> = {};
  const secrets: Partial<Record<ConfigField, SettingsSecretState>> = {};

  for (const field of CONFIG_FIELD_NAMES) {
    const value = storedValue(stored, field);
    if (FIELDS[field].secret) continue;
    if (value !== null) values[field] = value;
  }

  for (const field of SECRET_FIELD_NAMES) {
    const value = storedValue(stored, field);
    secrets[field] = typeof value === 'string' && value
      ? secretState(value)
      : (effective.secrets[field] ?? secretState(''));
  }

  // 只给「有探测手段」的 tab 算状态；没有字段的 tab 直接不出现（页面不渲染徽标）
  const groupStatus: SettingsPayload['groupStatus'] = {};
  for (const group of ['school', 'quota', 'auth'] as const) {
    if (groupStatusKeys(group).length === 0) continue;
    groupStatus[group] = readProbeGroupStatus(stored, SETTINGS_PROBE_GROUP[group] as ProbeGroup);
  }

  return {
    values,
    // 存过库的值优先；没存过的项回落到 env/默认值（不依赖 overlay 是否已加载）
    effective: { ...effective.values, ...values },
    // 密钥：数据库有值即显示「已配置」；未配置时为空
    secrets: { ...effective.secrets, ...secrets },
    brokenFields: stored.brokenFields,
    logoUrl: brandLogoUrl(stored.app.logo ?? ''),
    retention: retentionState(),
    groupStatus,
  };
}
