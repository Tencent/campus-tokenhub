/**
 * 配置字段模型：两张结构化表的类型化「唯一声明处」。
 *
 * 替代原来的 `CONFIG_REGISTRY`（一行一个 key 字符串）：
 * - `StoredAppConfig` / `StoredLoginConfig` 是数据库行的类型化形状（NULL = 未配置，回落 env/默认值）；
 * - `APP_FIELDS` / `LOGIN_FIELDS` 声明每个字段的列名、校验规则与稳定元信息；
 * - 上层只按字段 id（keyof Stored*）读写，不再用 `auth.*` 之类的字符串做查找。
 *
 * `auditName` / `cryptoKey` 保留旧 key 名不是业务 key：前者让审计记录可读且连续，
 * 后者是历史密文的 HKDF info + AAD，换掉会导致已落库的 Client Secret / AK/SK 解不开。
 */

import {
  PERMISSION_ID_MAX,
  PERMISSION_ID_MIN,
  REQUIRED_PERMISSION_IDS,
  toList,
} from './parse';
import { isDangerousSvg, parseLogoDataUrl } from './logo';

export class ConfigValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValueError';
  }
}

/** 登录限制可用的字段（与字段映射后的身份字段同名；`custom` 表示任意 claims 级联路径） */
export type RestrictFieldName =
  | 'subject'
  | 'email'
  | 'name'
  | 'schoolCode'
  | 'schoolName'
  | 'roles'
  | 'custom';

export const RESTRICT_FIELD_NAMES: readonly RestrictFieldName[] = [
  'subject',
  'email',
  'name',
  'schoolCode',
  'schoolName',
  'roles',
  'custom',
];

/**
 * 登录限制条件：多条之间是「且」，全部满足才允许登录；
 * 单条按该字段的候选值「任一命中」（`roles` 这类多值字段才有多个候选）。
 */
export type RestrictCondition = {
  field: RestrictFieldName;
  /** 仅 field='custom' 使用：claims 级联路径，如 data.user_id */
  path: string;
  value: string;
};

export type ConfigValue =
  | string
  | number
  | boolean
  | string[]
  | number[]
  | RestrictCondition[];
export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string[]'
  | 'number[]'
  | 'conditions'
  | 'image';
export type ProbeGroup = 'tencent' | 'currency';
export type ConfigSection = 'app' | 'login';
export type SettingsGroup = 'school' | 'quota' | 'member' | 'auth';

export type StoredAppConfig = {
  schoolName: string | null;
  loginTitle: string | null;
  loginSubtitle: string | null;
  footerContact: string | null;
  brandColor: string | null;
  logo: string | null;
  defaultBudgetMax: number | null;
  defaultBudgetPeriod: string | null;
  /** 开户默认限流（写入网关 `users.rate_limit`）；NULL = 不限 */
  defaultRateLimitRpm: number | null;
  defaultRateLimitTpm: number | null;
  /** 登录数据统计总开关：NULL / false = 关闭（缺省关闭），true 才采集与展示 */
  activityEnabled: boolean | null;
  tencentSecretId: string | null;
  tencentSecretKey: string | null;
  tencentPermissionIds: number[] | null;
};

export type StoredLoginConfig = {
  provider: string | null;
  oauth2AuthorizationEndpoint: string | null;
  oauth2TokenEndpoint: string | null;
  oauth2UserInfoEndpoint: string | null;
  oauth2ClientId: string | null;
  oauth2ClientSecret: string | null;
  oauth2Scopes: string | null;
  oauth2TokenAuthMethod: string | null;
  oauth2UserInfoTokenCarrier: string | null;
  oauth2FieldMapSubject: string | null;
  oauth2FieldMapEmail: string | null;
  oauth2FieldMapName: string | null;
  oauth2FieldMapSchoolCode: string | null;
  oauth2FieldMapSchoolName: string | null;
  oauth2FieldMapRoles: string | null;
  /** 登录用户角色命中这些值时自动加入管理员名单（只增不删） */
  adminRoles: string[] | null;
  casLoginUrl: string | null;
  casTicketValidateUrl: string | null;
  /** 企业微信自建应用：三项必填 + 可选授权范围（未配置回落 snsapi_base） */
  wecomCorpId: string | null;
  wecomAgentId: string | null;
  wecomClientSecret: string | null;
  wecomScope: string | null;
  restrictEnabled: boolean | null;
  restrictConditions: RestrictCondition[] | null;
  /** 部署管理员（引导期账号密码登录）：只在 SSO 未齐或救急时用 */
  localAdminMode: string | null;
  localAdminUsername: string | null;
  localAdminPassword: string | null;
};

export type AppField = keyof StoredAppConfig;
export type LoginField = keyof StoredLoginConfig;
export type ConfigField = AppField | LoginField;

export type FieldDescriptor = {
  /** 数据库列名（只由类型化描述符提供，不接受外部输入） */
  column: string;
  section: ConfigSection;
  auditName: string;
  /** 只有密钥字段有：必须与旧版 key 完全一致，保证历史密文可解 */
  cryptoKey?: string;
  env?: string;
  type: FieldType;
  label: string;
  description?: string;
  secret?: boolean;
  enumValues?: readonly string[];
  min?: number;
  max?: number;
  exclusiveMin?: boolean;
  integer?: boolean;
  maxLength?: number;
  pattern?: RegExp;
  patternHint?: string;
  requiredItems?: readonly number[];
  probeGroup?: ProbeGroup;
};

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const HTTP_URL = /^https?:\/\/[^\s]+$/i;

/** 企业微信配置的可复用片段：AgentID 格式、scope 枚举与默认值只有这一处来源 */
export const WECOM_AGENT_ID_PATTERN = /^\d+$/;
export const WECOM_SCOPES = ['snsapi_base', 'snsapi_privateinfo'] as const;
export type WecomScope = (typeof WECOM_SCOPES)[number];
export const DEFAULT_WECOM_SCOPE: WecomScope = 'snsapi_base';

export const APP_FIELDS: Record<AppField, FieldDescriptor> = {
  schoolName: {
    column: 'school_name', section: 'app', auditName: 'portal.school_name',
    env: 'PORTAL_SCHOOL_NAME', type: 'string', label: '学校名称',
    description: '侧边栏展示；登录时认证方返回校名时以登录值为准', maxLength: 60,
  },
  loginTitle: {
    column: 'login_title', section: 'app', auditName: 'portal.login_title',
    type: 'string', label: '登录页标题', maxLength: 60,
  },
  loginSubtitle: {
    column: 'login_subtitle', section: 'app', auditName: 'portal.login_subtitle',
    type: 'string', label: '登录页副标题', maxLength: 120,
  },
  footerContact: {
    column: 'footer_contact', section: 'app', auditName: 'portal.footer_contact',
    type: 'string', label: '页脚联系窗口',
    description: '如「账号无法登录？联系信息化办公室 010-xxxx」', maxLength: 120,
  },
  brandColor: {
    column: 'brand_color', section: 'app', auditName: 'portal.brand_color',
    type: 'string', label: '主题色', pattern: HEX_COLOR, patternHint: '#rgb 或 #rrggbb', maxLength: 7,
  },
  logo: {
    column: 'logo', section: 'app', auditName: 'portal.logo',
    type: 'image', label: 'Logo', description: 'PNG / JPEG / SVG，不超过 200KB', maxLength: 280_000,
  },
  defaultBudgetMax: {
    column: 'default_budget_max', section: 'app', auditName: 'portal.default_budget_max',
    env: 'DEFAULT_BUDGET_MAX', type: 'number', label: '开户默认额度',
    min: 0, exclusiveMin: true, probeGroup: 'currency',
  },
  defaultBudgetPeriod: {
    column: 'default_budget_period', section: 'app', auditName: 'portal.default_budget_period',
    env: 'DEFAULT_BUDGET_PERIOD', type: 'enum', label: '额度周期',
    enumValues: ['daily', 'monthly', 'none'], probeGroup: 'currency',
  },
  // 默认限流：开户时写入网关 `users.rate_limit`；0 是有效值（拒绝全部），留空才表示不限
  defaultRateLimitRpm: {
    column: 'default_rate_limit_rpm', section: 'app', auditName: 'portal.default_rate_limit_rpm',
    env: 'DEFAULT_RATE_LIMIT_RPM', type: 'number', label: '开户默认 RPM',
    min: 0, integer: true,
  },
  defaultRateLimitTpm: {
    column: 'default_rate_limit_tpm', section: 'app', auditName: 'portal.default_rate_limit_tpm',
    env: 'DEFAULT_RATE_LIMIT_TPM', type: 'number', label: '开户默认 TPM',
    min: 0, integer: true,
  },
  activityEnabled: {
    column: 'activity_enabled', section: 'app', auditName: 'portal.activity_enabled',
    type: 'boolean', label: '登录数据统计',
    description: '开启后采集两站的登录与页面访问，并在管理台「分析 → 登录数据」展示；关闭时不采集、接口关闭、菜单隐藏',
  },
  tencentSecretId: {
    column: 'tencent_secret_id_enc', section: 'app', auditName: 'tencent.secret_id',
    cryptoKey: 'tencent.secret_id', env: 'TENCENTCLOUD_SECRET_ID',
    type: 'string', label: '腾讯云 CAM SecretId', secret: true, maxLength: 128,
    probeGroup: 'tencent',
  },
  tencentSecretKey: {
    column: 'tencent_secret_key_enc', section: 'app', auditName: 'tencent.secret_key',
    cryptoKey: 'tencent.secret_key', env: 'TENCENTCLOUD_SECRET_KEY',
    type: 'string', label: '腾讯云 CAM SecretKey', secret: true, maxLength: 256,
    probeGroup: 'tencent',
  },
  tencentPermissionIds: {
    column: 'tencent_permission_ids', section: 'app', auditName: 'tencent.permission_ids',
    env: 'MEMBER_ACCOUNT_PERMISSION_IDS', type: 'number[]', label: '财务权限',
    min: PERMISSION_ID_MIN, max: PERMISSION_ID_MAX, integer: true,
    requiredItems: REQUIRED_PERMISSION_IDS,
  },
};

export const LOGIN_FIELDS: Record<LoginField, FieldDescriptor> = {
  localAdminMode: {
    column: 'local_admin_mode', section: 'login', auditName: 'auth.localAdmin.mode',
    env: 'PORTAL_ADMIN_LOGIN', type: 'enum', label: '账号密码登录',
    description:
      'auto：默认保留，由运维确认 SSO 调通后手动改 off 关闭（推荐）；on：强制保留，仅救急用；off：始终关闭',
    enumValues: ['auto', 'on', 'off'],
  },
  localAdminUsername: {
    column: 'local_admin_username', section: 'login', auditName: 'auth.localAdmin.username',
    env: 'PORTAL_ADMIN_USERNAME', type: 'string', label: '部署管理员账号',
    description: '第一次配置 SSO 时用；调通后由运维把「账号密码登录」改成 off 关闭',
    maxLength: 64,
  },
  localAdminPassword: {
    column: 'local_admin_password_enc', section: 'login', auditName: 'auth.localAdmin.password',
    cryptoKey: 'auth.localAdmin.password', env: 'PORTAL_ADMIN_PASSWORD',
    type: 'string', label: '部署管理员密码', secret: true, maxLength: 256,
    description: '落库加密保存；留空表示不配置（不显示原值）',
  },
  provider: {
    column: 'provider', section: 'login', auditName: 'auth.provider',
    env: 'AUTH_PROVIDER', type: 'enum', label: 'SSO 协议',
    description: '先选协议，下面只显示该协议需要的参数；保存后立即生效',
    enumValues: ['oauth2', 'cas', 'wecom'],
  },
  oauth2AuthorizationEndpoint: {
    column: 'oauth2_authorization_endpoint', section: 'login', auditName: 'auth.oauth2.authorizationEndpoint',
    env: 'OAUTH2_AUTHORIZATION_ENDPOINT', type: 'string', label: '认证授权端点 URL',
    description: '即 Authorization Endpoint，浏览器跳到这里授权', pattern: HTTP_URL, maxLength: 500,
  },
  oauth2TokenEndpoint: {
    column: 'oauth2_token_endpoint', section: 'login', auditName: 'auth.oauth2.tokenEndpoint',
    env: 'OAUTH2_TOKEN_ENDPOINT', type: 'string', label: 'Token 端点 URL',
    description: '即 Token Endpoint，服务端用 authorization code 换 token', pattern: HTTP_URL, maxLength: 500,
  },
  oauth2UserInfoEndpoint: {
    column: 'oauth2_user_info_endpoint', section: 'login', auditName: 'auth.oauth2.userInfoEndpoint',
    env: 'OAUTH2_USERINFO_ENDPOINT', type: 'string', label: '用户信息端点 URL',
    description: '即 Userinfo Endpoint，用 token 读取当前用户身份', pattern: HTTP_URL, maxLength: 500,
  },
  oauth2ClientId: {
    column: 'oauth2_client_id', section: 'login', auditName: 'auth.oauth2.clientId',
    env: 'OAUTH2_CLIENT_ID', type: 'string', label: 'Client ID', maxLength: 200,
  },
  oauth2ClientSecret: {
    column: 'oauth2_client_secret_enc', section: 'login', auditName: 'auth.oauth2.clientSecret',
    cryptoKey: 'auth.oauth2.clientSecret', env: 'OAUTH2_CLIENT_SECRET',
    type: 'string', label: 'Client Secret', secret: true, maxLength: 256,
  },
  oauth2Scopes: {
    column: 'oauth2_scopes', section: 'login', auditName: 'auth.oauth2.scopes',
    env: 'OAUTH2_SCOPES', type: 'string', label: '授权范围',
    description: '空格分隔；留空回落 openid profile email', maxLength: 300,
  },
  oauth2TokenAuthMethod: {
    column: 'oauth2_token_auth_method', section: 'login', auditName: 'auth.oauth2.tokenAuthMethod',
    env: 'OAUTH2_TOKEN_AUTH_METHOD', type: 'enum', label: 'Token 端点认证方式',
    description: '对应 Token Endpoint Auth Method',
    enumValues: ['client_secret_basic', 'client_secret_post'],
  },
  oauth2UserInfoTokenCarrier: {
    column: 'oauth2_user_info_token_carrier', section: 'login', auditName: 'auth.oauth2.userInfoTokenCarrier',
    env: 'OAUTH2_USERINFO_TOKEN_CARRIER', type: 'enum', label: 'UserInfo Token 携带方式',
    enumValues: ['header', 'query'],
  },
  oauth2FieldMapSubject: {
    column: 'oauth2_field_map_subject', section: 'login', auditName: 'auth.oauth2.fieldMap.subject',
    type: 'string', label: '外部用户 ID',
    description: 'userinfo 里的字段路径，如 user_id 或 data.user_id；支持 {school_id}:{user_id} 模板；留空用内置兼容字段',
    maxLength: 200,
  },
  oauth2FieldMapEmail: {
    column: 'oauth2_field_map_email', section: 'login', auditName: 'auth.oauth2.fieldMap.email',
    type: 'string', label: '邮箱',
    description: '留空时用外部用户 ID 派生 @school.local 地址', maxLength: 200,
  },
  oauth2FieldMapName: {
    column: 'oauth2_field_map_name', section: 'login', auditName: 'auth.oauth2.fieldMap.name',
    type: 'string', label: '姓名',
    description: '留空时回退 user_name / name / nickname 等内置字段', maxLength: 200,
  },
  oauth2FieldMapSchoolCode: {
    column: 'oauth2_field_map_school_code', section: 'login', auditName: 'auth.oauth2.fieldMap.schoolCode',
    type: 'string', label: '学校编码',
    description: '机构 / 学校 ID 字段路径，如 school_id；供登录限制匹配', maxLength: 200,
  },
  oauth2FieldMapSchoolName: {
    column: 'oauth2_field_map_school_name', section: 'login', auditName: 'auth.oauth2.fieldMap.schoolName',
    type: 'string', label: '学校名称',
    description: '学校名称字段路径，如 school_name；侧边栏优先显示该值', maxLength: 200,
  },
  oauth2FieldMapRoles: {
    column: 'oauth2_field_map_roles', section: 'login', auditName: 'auth.oauth2.fieldMap.roles',
    type: 'string', label: '角色',
    description: '角色字段路径，如 role_name；支持数组或逗号分隔字符串', maxLength: 200,
  },
  adminRoles: {
    column: 'admin_roles', section: 'login', auditName: 'auth.adminRoles',
    type: 'string[]', label: '自动同步为管理员的角色',
    description:
      '登录用户的角色命中下列任一值（忽略大小写）时，自动加入管理员名单；只新增不删除，留空表示关闭',
    patternHint: '多个角色用逗号分隔，如 school_admin, super_admin',
    maxLength: 500,
  },
  casLoginUrl: {
    column: 'cas_login_url', section: 'login', auditName: 'auth.cas.loginUrl',
    env: 'CAS_LOGIN_URL', type: 'string', label: 'CAS 认证 URL',
    description: '学校 CAS Server 的登录地址', pattern: HTTP_URL, maxLength: 500,
  },
  casTicketValidateUrl: {
    column: 'cas_ticket_validate_url', section: 'login', auditName: 'auth.cas.ticketValidateUrl',
    env: 'CAS_TICKET_VALIDATE_URL', type: 'string', label: 'CAS Ticket 校验 URL',
    description: '学校 CAS Server 的 serviceValidate 地址', pattern: HTTP_URL, maxLength: 500,
  },
  wecomCorpId: {
    column: 'wecom_corp_id', section: 'login', auditName: 'auth.wecom.corpId',
    type: 'string', label: '企业 CorpID',
    description: '企业微信「我的企业 → 企业信息」页面获取', maxLength: 200,
  },
  wecomAgentId: {
    column: 'wecom_agent_id', section: 'login', auditName: 'auth.wecom.agentId',
    type: 'string', label: '应用 AgentID',
    description: '自建应用详情页的 AgentId，只能是数字', maxLength: 64,
    pattern: WECOM_AGENT_ID_PATTERN, patternHint: '纯数字，如 1000002',
  },
  wecomClientSecret: {
    column: 'wecom_client_secret_enc', section: 'login', auditName: 'auth.wecom.clientSecret',
    cryptoKey: 'auth.wecom.clientSecret',
    type: 'string', label: '应用 Secret', secret: true, maxLength: 256,
    description: '落库加密保存；留空表示不修改，如需清除请使用清除操作',
  },
  wecomScope: {
    column: 'wecom_scope', section: 'login', auditName: 'auth.wecom.scope',
    type: 'enum', label: '网页授权范围',
    description: '留空回落 snsapi_base；需要读取敏感资料时才选 snsapi_privateinfo',
    enumValues: WECOM_SCOPES,
  },
  restrictEnabled: {
    column: 'restrict_enabled', section: 'login', auditName: 'auth.restrict.enabled',
    type: 'boolean', label: '限制可登录的用户',
    description: '开启后，只有下方字段命中允许值的账号才能登录',
  },
  restrictConditions: {
    column: 'restrict_conditions', section: 'login', auditName: 'auth.restrict.conditions',
    type: 'conditions', label: '允许登录的条件',
    description: '多条条件必须全部满足（且）才能登录；同一字段只能填一个值',
  },
};

export const FIELDS: Record<ConfigField, FieldDescriptor> = {
  ...APP_FIELDS,
  ...LOGIN_FIELDS,
};

export const APP_FIELD_NAMES = Object.keys(APP_FIELDS) as AppField[];
export const LOGIN_FIELD_NAMES = Object.keys(LOGIN_FIELDS) as LoginField[];
export const CONFIG_FIELD_NAMES = Object.keys(FIELDS) as ConfigField[];
export const SECRET_FIELD_NAMES = CONFIG_FIELD_NAMES.filter(
  (field) => FIELDS[field].secret
) as Extract<ConfigField, 'tencentSecretId' | 'tencentSecretKey' | 'oauth2ClientSecret' | 'wecomClientSecret'>[];

/** 设置页分组：每个字段只属于一个 tab，避免再用 `auth.*` 前缀猜归属 */
export const SETTINGS_GROUP_FIELDS: Record<SettingsGroup, readonly ConfigField[]> = {
  school: [
    'schoolName', 'loginTitle', 'loginSubtitle', 'footerContact', 'brandColor', 'logo',
    'activityEnabled',
  ],
  quota: [
    'defaultBudgetMax', 'defaultBudgetPeriod',
    'defaultRateLimitRpm', 'defaultRateLimitTpm',
  ],
  member: ['tencentSecretId', 'tencentSecretKey', 'tencentPermissionIds'],
  auth: LOGIN_FIELD_NAMES,
};

export function isConfigField(value: unknown): value is ConfigField {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FIELDS, value);
}

export function fieldsForSettingsGroup(group: SettingsGroup): readonly ConfigField[] {
  return SETTINGS_GROUP_FIELDS[group];
}

/** 只读的构建期 / 部署参数（与旧 READONLY_ENV_KEYS 同口径） */
export const READONLY_ENV_KEYS = [
  { env: 'PORTAL_BASE_PATH', label: '门户挂载前缀', reason: '构建期生效，需重建镜像' },
  { env: 'ADMIN_UI_PUBLIC_PATH', label: '管理台公网前缀', reason: '构建期生效，需重建镜像' },
  { env: 'PORTAL_DATABASE_URL', label: '门户数据库连接', reason: '基础设施，需改环境变量' },
] as const;

export function descriptor(field: ConfigField): FieldDescriptor {
  const def = FIELDS[field];
  if (!def) throw new ConfigValueError(`未知的配置字段：${field}`);
  return def;
}

/** 空的结构化配置：所有字段 NULL = 完全回落 env / 默认值。放在无依赖模块，edge 也能安全引用。 */
export function emptyStoredValues(): { app: StoredAppConfig; login: StoredLoginConfig } {
  const app = {} as StoredAppConfig;
  for (const field of APP_FIELD_NAMES) app[field] = null;
  const login = {} as StoredLoginConfig;
  for (const field of LOGIN_FIELD_NAMES) login[field] = null;
  return { app, login };
}

export function fieldsForProbe(group: ProbeGroup): ConfigField[] {
  return CONFIG_FIELD_NAMES.filter((name) => FIELDS[name].probeGroup === group);
}

function asString(field: FieldDescriptor, raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ConfigValueError(`${field.label} 必须是文本`);
  }
  const value = raw.trim();
  if (value.length > (field.maxLength ?? 500)) {
    throw new ConfigValueError(`${field.label} 不能超过 ${field.maxLength ?? 500} 个字符`);
  }
  if (field.pattern && !field.pattern.test(value)) {
    throw new ConfigValueError(
      `${field.label} 格式不正确，应形如 ${field.patternHint ?? String(field.pattern)}`
    );
  }
  return value;
}

/** 表单以 JSON 字符串提交条件列表；解析失败按「格式不对」报错，不静默清空 */
function parseConditionJson(def: FieldDescriptor, raw: string): unknown {
  const text = raw.trim();
  if (!text) return [];
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConfigValueError(`${def.label} 不是合法的条件列表`);
  }
}

/** 按类型化字段校验并转换输入值；所有写入必须先过这里 */
export function toConfigValue(field: ConfigField, raw: unknown): ConfigValue {
  const def = descriptor(field);
  switch (def.type) {
    case 'string':
    case 'image': {
      const value = asString(def, raw);
      // 与上传接口同口径：设置页直接贴 data URL 时也要过一遍危险特征，
      // 否则「上传会被拦、手贴能存」就是一条绕过路径（回传虽有 CSP 兜底，但不该靠它）
      if (value.startsWith('data:image/svg+xml')) {
        const parsed = parseLogoDataUrl(value);
        if (parsed && isDangerousSvg(parsed.bytes)) {
          throw new ConfigValueError(`${def.label} 含有可执行内容（脚本/事件属性），已拒绝保存`);
        }
      }
      return value;
    }
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) {
        throw new ConfigValueError(`${def.label} 必须是数字`);
      }
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) {
        throw new ConfigValueError(`${def.label} 必须是数字，当前是 ${String(raw)}`);
      }
      if (def.integer && !Number.isInteger(value)) {
        throw new ConfigValueError(`${def.label} 必须是整数`);
      }
      if (def.min !== undefined) {
        if (def.exclusiveMin ? value <= def.min : value < def.min) {
          throw new ConfigValueError(
            def.exclusiveMin ? `${def.label} 必须大于 ${def.min}` : `${def.label} 不能小于 ${def.min}`
          );
        }
      }
      if (def.max !== undefined && value > def.max) {
        throw new ConfigValueError(`${def.label} 不能大于 ${def.max}`);
      }
      return value;
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return raw;
      const text = String(raw).trim().toLowerCase();
      if (text === 'true' || text === '1' || text === 'on') return true;
      if (text === 'false' || text === '0' || text === 'off') return false;
      throw new ConfigValueError(`${def.label} 只能是 true 或 false，当前是 ${String(raw)}`);
    }
    case 'enum': {
      const values = def.enumValues ?? [];
      const value = String(raw).trim();
      if (!values.includes(value)) {
        throw new ConfigValueError(
          `${def.label} 只能是 ${values.join('、')}，当前是 ${value || '空'}`
        );
      }
      return value;
    }
    case 'string[]': {
      const list = Array.isArray(raw) ? raw : toList(String(raw));
      const cleaned: string[] = [];
      for (const item of list) {
        if (typeof item !== 'string') throw new ConfigValueError(`${def.label} 只能包含文本`);
        const value = item.trim();
        if (value && !cleaned.includes(value)) cleaned.push(value);
      }
      return cleaned;
    }
    case 'number[]': {
      const list = Array.isArray(raw) ? raw : toList(String(raw));
      const parsed: number[] = [];
      for (const item of list) {
        if (typeof item === 'string' && !item.trim()) continue;
        const value = Number(typeof item === 'string' ? item.trim() : item);
        if (!Number.isFinite(value)) {
          throw new ConfigValueError(`${def.label} 只能包含数字，当前包含 ${String(item)}`);
        }
        if (def.integer && !Number.isInteger(value)) {
          throw new ConfigValueError(`${def.label} 只能包含整数`);
        }
        if (def.min !== undefined && value < def.min) {
          throw new ConfigValueError(`${def.label} 取值不能小于 ${def.min}`);
        }
        if (def.max !== undefined && value > def.max) {
          throw new ConfigValueError(`${def.label} 取值不能大于 ${def.max}`);
        }
        parsed.push(value);
      }
      const unique = [...new Set(parsed)].sort((a, b) => a - b);
      const missing = (def.requiredItems ?? []).filter((id) => !unique.includes(id));
      if (missing.length > 0) {
        throw new ConfigValueError(
          `${def.label} 必须包含 ${def.requiredItems?.join('、')}，当前缺少 ${missing.join('、')}`
        );
      }
      return unique;
    }
    case 'conditions': {
      const list = typeof raw === 'string' ? parseConditionJson(def, raw) : raw;
      if (!Array.isArray(list)) throw new ConfigValueError(`${def.label} 必须是条件列表`);
      const cleaned: RestrictCondition[] = [];
      for (const item of list) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new ConfigValueError(`${def.label} 的每一项必须是「字段 + 取值」`);
        }
        const record = item as Record<string, unknown>;
        const name = String(record.field ?? '').trim();
        if (!RESTRICT_FIELD_NAMES.includes(name as RestrictFieldName)) {
          throw new ConfigValueError(`${def.label} 里有不支持的字段：${name || '空'}`);
        }
        const path = typeof record.path === 'string' ? record.path.trim() : '';
        const value = String(record.value ?? '').trim();
        // 半填的行按「草稿」跳过，不报错：
        //   1) 关闭登录限制时，页面上可能留着没填完的行，不该因此拦住整份保存
        //      （用户真实场景：开了开关 → 又关掉 → 保存被拒）；
        //   2) 启用状态下「条件不足」由 validateAuthSectionErrors 统一报错，口径只有一处，
        //      避免字段级与跨字段两套文案打架。
        if (!value) continue;
        if (name === 'custom' && !path) continue;
        const condition: RestrictCondition = {
          field: name as RestrictFieldName,
          path: name === 'custom' ? path : '',
          value,
        };
        // 同一字段 + 同一取值只留一条：重复条件对「且」的判断没有意义
        const seen = cleaned.some(
          (itemCondition) =>
            itemCondition.field === condition.field &&
            itemCondition.path === condition.path &&
            itemCondition.value.toLowerCase() === condition.value.toLowerCase()
        );
        if (!seen) cleaned.push(condition);
      }
      return cleaned;
    }
    default:
      throw new ConfigValueError(`${def.label} 的类型不支持`);
  }
}

/** 表单失焦提示用：只返回字段 id 与中文错误，不抛异常 */
export function validateField(field: ConfigField, raw: unknown): { field: ConfigField; message: string } | null {
  try {
    toConfigValue(field, raw);
    return null;
  } catch (error) {
    if (error instanceof ConfigValueError) return { field, message: error.message };
    throw error;
  }
}

/** 从环境变量读字段值；缺失或空白返回 undefined（由 env 基础配置提供默认值） */
export function fromEnv(field: ConfigField, env: Record<string, string | undefined>): ConfigValue | undefined {
  const key = descriptor(field).env;
  if (!key) return undefined;
  const raw = env[key];
  if (raw === undefined || !raw.trim()) return undefined;
  return toConfigValue(field, raw);
}

/** 明文列 / 数组列的序列化：DB 里数组以 JSON 文本或原生数组存储，二者都由此转换 */
export function serializeFieldValue(field: ConfigField, value: ConfigValue): string {
  const type = descriptor(field).type;
  if (type === 'string[]' || type === 'number[]' || type === 'conditions') {
    return JSON.stringify(value);
  }
  return String(value);
}

export function deserializeFieldValue(field: ConfigField, text: string): ConfigValue {
  const type = descriptor(field).type;
  if (type === 'string[]' || type === 'number[]' || type === 'conditions') {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('配置值不是数组');
    return toConfigValue(field, parsed);
  }
  return toConfigValue(field, text);
}
