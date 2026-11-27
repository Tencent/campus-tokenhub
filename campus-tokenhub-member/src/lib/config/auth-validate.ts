/**
 * 认证参数校验与 fail-closed 守卫。
 *
 * 分工：
 * - `validateAuthSectionErrors`：跨字段/启动期/保存期安全规则，返回结构化错误供设置页内联提示
 * - `validateAuthSection`：同上，返回文案数组（启动层/接口层沿用）
 * - `assertAuthSafe`：O(1) 运行时守卫，拒绝未注册的 SSO 协议，供认证决策汇聚点调用
 * - `decideStartupAuth`：启动层判定，便于单测且避免竞态
 * - `mergeDraftAuth`：把类型化配置草稿合并成临时 auth 供校验，不落库
 *
 * 单字段格式复用 `fields.ts` 的声明式校验，不在此重复实现。
 */

import type { AppConfig } from '@/lib/config';
import {
  LOGIN_FIELDS,
  ConfigValueError,
  DEFAULT_WECOM_SCOPE,
  fromEnv,
  toConfigValue,
  type ConfigField,
  type ConfigValue,
  type LoginField,
} from './fields';
import { applyLoginField, cloneAuth } from './overlay';
import type { FieldError } from './validate-field';

/** provider 枚举唯一来源：字段描述符（避免与字段模型形成两套口径） */
const PROVIDERS: readonly string[] = LOGIN_FIELDS.provider.enumValues ?? ['oauth2', 'cas'];

/** 当前协议必须填写的字段；账号密码登录的关闭判据与设置页校验共用这一份清单 */
export type RequiredSsoField = { key: LoginField; label: string; value: string };

/**
 * 按**当前生效协议**列出必填项。
 *
 * 只描述「能不能真的发起一次 SSO」：oauth2 五项（三个端点 + 客户端凭据），
 * cas 两项（认证地址 + 票校验地址），wecom 三项（CorpID + AgentID + Secret）。
 * 字段映射与登录限制不在此列——它们是登录后的
 * 身份处理，缺了不影响「学校已对接 SSO」这件事。
 */
export function requiredSsoFields(auth: AppConfig['auth']): RequiredSsoField[] {
  if (auth.provider === 'oauth2') {
    return [
      {
        key: 'oauth2AuthorizationEndpoint',
        label: '认证授权端点 URL',
        value: auth.oauth2.authorizationEndpoint,
      },
      { key: 'oauth2TokenEndpoint', label: 'Token 端点 URL', value: auth.oauth2.tokenEndpoint },
      {
        key: 'oauth2UserInfoEndpoint',
        label: '用户信息端点 URL',
        value: auth.oauth2.userInfoEndpoint,
      },
      { key: 'oauth2ClientId', label: 'Client ID', value: auth.oauth2.clientId },
      { key: 'oauth2ClientSecret', label: 'Client Secret', value: auth.oauth2.clientSecret },
    ];
  }
  if (auth.provider === 'cas') {
    return [
      { key: 'casLoginUrl', label: 'CAS 认证 URL', value: auth.cas.loginUrl },
      { key: 'casTicketValidateUrl', label: 'CAS Ticket 校验 URL', value: auth.cas.ticketValidateUrl },
    ];
  }
  if (auth.provider === 'wecom') {
    return [
      { key: 'wecomCorpId', label: '企业 CorpID', value: auth.wecom.corpId },
      { key: 'wecomAgentId', label: '应用 AgentID', value: auth.wecom.agentId },
      { key: 'wecomClientSecret', label: '应用 Secret', value: auth.wecom.secret },
    ];
  }
  return [];
}

/**
 * 学校 SSO 是否已对接完成：当前协议必填项全部非空。
 *
 * 这是「引导期账号密码登录」的唯一关闭判据（fail-closed）：
 * - 空配置（provider 默认 oauth2、参数全空）→ false，救急通道可用；
 * - 只填一半（例如缺 Client Secret）→ 仍然 false，避免把部署锁死；
 * - 齐全 → true，账号密码登录立即关闭，不留绕开学校统一认证的口子。
 *
 * 空白串按缺失处理：设置页允许保存空格，不能因为一个空格就被判成已对接。
 */
export function isSsoConfigured(auth: AppConfig['auth']): boolean {
  const fields = requiredSsoFields(auth);
  return fields.length > 0 && fields.every((field) => (field.value ?? '').trim() !== '');
}

/** 必填 + 单字段格式（格式规则来自字段描述符） */
function checkRequired(
  errors: FieldError[],
  field: LoginField,
  label: string,
  value: string | undefined
): void {
  const text = (value ?? '').trim();
  if (!text) {
    errors.push({ key: field, message: `${label} 不能为空` });
    return;
  }
  try {
    toConfigValue(field, text);
  } catch (error) {
    if (error instanceof ConfigValueError) errors.push({ key: field, message: error.message });
    else throw error;
  }
}

/**
 * 完整校验（结构化）：启动期与保存期共用。
 *
 * `nodeEnv` 由调用方显式传入，不读函数内全局，避免与可注入的 `loadConfig(env)` 口径不一致。
 */
export function validateAuthSectionErrors(
  auth: AppConfig['auth'],
  nodeEnv: string
): FieldError[] {
  // 目前 oauth2 / cas 没有环境差异；保留参数避免调用方随安全规则调整反复改签名
  void nodeEnv;
  const errors: FieldError[] = [];
  const provider = auth.provider;

  if (!PROVIDERS.includes(provider)) {
    errors.push({
      key: 'provider',
      message: `认证方式只能是 ${PROVIDERS.join('、')}，当前是 ${provider || '空'}`,
    });
    return errors;
  }

  // 必填项只有一份来源：requiredSsoFields()，避免校验与「是否已对接」两套口径
  for (const field of requiredSsoFields(auth)) {
    checkRequired(errors, field.key, field.label, field.value);
  }
  // 登录限制：启用后必须至少有一条完整条件，否则会放行或误拒所有账号
  if (auth.restrict.enabled) {
    const conditions = auth.restrict.conditions;
    if (conditions.length === 0) {
      errors.push({ key: 'restrictConditions', message: '启用登录限制时，至少要填写一条条件' });
    } else if (conditions.some((item) => item.field === 'custom' && !item.path.trim())) {
      errors.push({ key: 'restrictConditions', message: '自定义字段条件必须填写字段路径' });
    } else if (conditions.some((item) => !item.value.trim())) {
      errors.push({ key: 'restrictConditions', message: '登录限制条件不能缺少取值' });
    }
  }

  return errors;
}

/** 兼容启动层/接口层：只返回文案 */
export function validateAuthSection(auth: AppConfig['auth'], nodeEnv: string): string[] {
  return validateAuthSectionErrors(auth, nodeEnv).map((error) => error.message);
}

/**
 * O(1) 运行时守卫：只放行字段描述符声明的三种协议。
 *
 * 放在认证决策汇聚点（`getAuthAdapter`）调用，拒绝签发会话；
 * 不在全局 `getConfig()` 抛错，保留会话验证/设置页等只读路径与自助恢复通道（R4）。
 */
export function assertAuthSafe(auth: AppConfig['auth'], nodeEnv: string): void {
  void nodeEnv;
  if (!PROVIDERS.includes(auth.provider)) {
    throw new Error(`不支持的 SSO 协议：${String(auth.provider)}，请改成 oauth2、cas 或 wecom`);
  }
}

export type StartupAuthDecision = 'fail' | 'warn' | 'ok';

/**
 * 启动层三分支判定（纯函数，便于单测）：
 * - `fail`：overlay 已加载且最终协议非法 → 拒绝启动
 * - `warn`：DB 不可达/超时（此时生效值是已校验的 env base）→ 放行但提示
 * - `ok`：协议合法
 */
export function decideStartupAuth(input: {
  overlayLoaded: boolean;
  provider: string;
  nodeEnv: string;
}): StartupAuthDecision {
  const invalid = !PROVIDERS.includes(input.provider);
  if (!invalid) return 'ok';
  return input.overlayLoaded ? 'fail' : 'warn';
}

/** 清空某字段后回落到「env 或类型默认值」 */
const AUTH_DEFAULTS: Partial<Record<LoginField, ConfigValue>> = {
  oauth2Scopes: 'openid profile email',
  oauth2TokenAuthMethod: 'client_secret_basic',
  oauth2UserInfoTokenCarrier: 'header',
  wecomScope: DEFAULT_WECOM_SCOPE,
};

function defaultValueFor(field: LoginField): ConfigValue {
  if (field in AUTH_DEFAULTS) return AUTH_DEFAULTS[field] as ConfigValue;
  switch (LOGIN_FIELDS[field].type) {
    case 'number': return 0;
    case 'boolean': return false;
    case 'string[]':
    case 'number[]':
    case 'conditions': return [];
    default: return '';
  }
}

/** 草稿里格式非法的值也映射进 auth，交给校验器统一报可读错误 */
function coerceDraftValue(field: LoginField, raw: unknown): ConfigValue {
  switch (LOGIN_FIELDS[field].type) {
    case 'number': return Number(raw);
    case 'boolean': return Boolean(raw);
    case 'string[]':
    case 'number[]':
    case 'conditions': return Array.isArray(raw) ? (raw as ConfigValue) : [];
    default: return String(raw ?? '');
  }
}

/**
 * 草稿 → 临时 auth：草稿优先、未填项保留已存/env 值；纯内存构造，不落库。
 *
 * - `draft`：设置页表单的类型化字段草稿（与 `validateSettings` 的 `values` 同形）
 * - `clearFields`：本次要清除的字段；清除后按 env 回落，无 env 时用类型默认值，
 *   保证「校验对象 == 落库后的最终生效值」，不会拿旧 DB 值误判通过。
 */
export function mergeDraftAuth(
  base: AppConfig['auth'],
  draft: Partial<Record<ConfigField, unknown>>,
  clearFields: ConfigField[] = []
): AppConfig['auth'] {
  const merged = cloneAuth(base);

  for (const field of clearFields) {
    if (LOGIN_FIELDS[field as LoginField] === undefined) continue;
    const loginField = field as LoginField;
    const envValue = fromEnv(loginField, process.env);
    applyLoginField(merged, loginField, envValue ?? defaultValueFor(loginField));
  }

  for (const [field, raw] of Object.entries(draft) as [ConfigField, unknown][]) {
    if (LOGIN_FIELDS[field as LoginField] === undefined) continue;
    const loginField = field as LoginField;
    let value: ConfigValue;
    try {
      value = toConfigValue(loginField, raw);
    } catch (error) {
      // 非法数字不写入，保留 base，交给字段级 validateSettings 报错
      if (error instanceof ConfigValueError && LOGIN_FIELDS[loginField].type === 'number'
        && !Number.isFinite(Number(raw))) continue;
      value = coerceDraftValue(loginField, raw);
    }
    applyLoginField(merged, loginField, value);
  }

  return merged;
}
