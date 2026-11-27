/**
 * 从 IdP 返回的 claims 中解析身份，并执行可配置的登录限制。
 *
 * 字段名不写死：映射留空时才回退内置兼容别名（snake_case / camelCase / OIDC），
 * 映射配了值就只认该字段，取不到按缺失处理（fail closed），
 * 避免悄悄换字段导致 external_user_id 变化、同一人被开两次户。
 */

import type { AppConfig, OAuth2FieldMap } from '@/lib/config';
import type { Identity } from './types';
import { AuthFlowError } from './types';

/** claims 里可能承载单个值或数组；数组按顺序取第一个非空项 */
export function claim(claims: Record<string, unknown>, names: readonly string[]): string {
  for (const name of names) {
    const value = claims[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) return item.trim();
        if (typeof item === 'number' && Number.isFinite(item)) return String(item);
      }
    }
  }
  return '';
}

/** 角色可能是数组、逗号分隔字符串或嵌套对象数组 */
export function claimList(claims: Record<string, unknown>, names: readonly string[]): string[] {
  const values: string[] = [];
  for (const name of names) {
    collectValues(claims[name], values);
  }
  return [...new Set(values)];
}

/** 把任意形状的值摊平成字符串列表（数组、逗号/分号串、对象取 name/role/label） */
function collectValues(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectValues(item, out);
    return out;
  }
  if (typeof value === 'string') {
    for (const part of value.split(/[,;|]/)) {
      const text = part.trim();
      if (text) out.push(text);
    }
    return out;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    out.push(String(value));
    return out;
  }
  if (value && typeof value === 'object') {
    const label = claim(value as Record<string, unknown>, ['name', 'role', 'roleName', 'label', 'value']);
    if (label) out.push(label);
  }
  return out;
}

const SUB_CLAIMS = ['sub', 'user_id', 'userId', 'id', 'uid', 'preferred_username'] as const;
const EMAIL_CLAIMS = ['email', 'mail', 'user_email', 'userEmail'] as const;
const NAME_CLAIMS = ['name', 'display_name', 'displayName', 'nickname', 'preferred_username'] as const;
const SCHOOL_NAME_CLAIMS = [
  'school_name',
  'schoolName',
  'school',
  'org_name',
  'orgName',
  'organization',
] as const;
const SCHOOL_CODE_CLAIMS = [
  'school_code',
  'schoolCode',
  'school_id',
  'schoolId',
  'corp_code',
  'corpCode',
  'tenant_id',
  'tenantId',
] as const;
const ROLE_CLAIMS = ['roles', 'role', 'role_list', 'roleList', 'authorities', 'groups'] as const;

/** 解析后的身份字段：既是 Identity 的来源，也是登录限制的取值池 */
export type MappedClaims = {
  subject: string;
  email: string;
  name: string;
  schoolCode: string;
  schoolName: string;
  roles: string[];
};

/** 按 `.` 逐层取值，支持数组下标（如 `data.members.0.id`） */
export function readClaimPath(claims: Record<string, unknown>, path: string): unknown {
  const segments = path
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length === 0) return undefined;

  let current: unknown = claims;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** 单个值取第一个可读项；数组按顺序取，对象取 value/name/id/label */
function firstValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstValue(item);
      if (text) return text;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    return claim(value as Record<string, unknown>, ['value', 'name', 'id', 'label']);
  }
  return '';
}

/**
 * 解析映射表达式：纯路径（`data.user_id`）或 `{school_id}:{user_id}` 模板。
 * 模板里任一占位取空视为未取到，返回空串，由调用方决定是否拒绝登录。
 */
export function resolveExpression(claims: Record<string, unknown>, expression: string): string {
  const expr = expression.trim();
  if (!expr) return '';
  if (!expr.includes('{')) return firstValue(readClaimPath(claims, expr));

  let missing = false;
  const text = expr.replace(/\{([^{}]+)\}/g, (_match, rawPath: string) => {
    const value = firstValue(readClaimPath(claims, rawPath.trim()));
    if (!value) missing = true;
    return value;
  });
  return missing ? '' : text.trim();
}

/** 解析字段映射；某项表达式留空时回退内置别名（普通 IdP / CAS 行为不变） */
export function resolveMappedClaims(
  claims: Record<string, unknown>,
  fieldMap?: Partial<OAuth2FieldMap>
): MappedClaims {
  const map = fieldMap ?? {};
  const pick = (expression: string | undefined, aliases: readonly string[]): string =>
    expression && expression.trim() ? resolveExpression(claims, expression) : claim(claims, aliases);

  const rolesExpression = map.roles?.trim();
  const roles = rolesExpression
    ? [...new Set(collectValues(readClaimPath(claims, rolesExpression)))]
    : claimList(claims, ROLE_CLAIMS);

  return {
    subject: pick(map.subject, SUB_CLAIMS),
    email: pick(map.email, EMAIL_CLAIMS),
    name: pick(map.name, NAME_CLAIMS),
    schoolCode: pick(map.schoolCode, SCHOOL_CODE_CLAIMS),
    schoolName: pick(map.schoolName, SCHOOL_NAME_CLAIMS),
    roles,
  };
}

/** 身份来自 IdP：sub 必填；邮箱缺失时用 sub 派生，避免网关开户拿到空邮箱 */
export function identityFromClaims(
  claims: Record<string, unknown>,
  fieldMap?: Partial<OAuth2FieldMap>
): Identity {
  return toIdentity(resolveMappedClaims(claims, fieldMap));
}

function toIdentity(mapped: MappedClaims): Identity {
  if (!mapped.subject) throw new AuthFlowError('identity_invalid', '身份信息缺少用户标识');
  const email = mapped.email || `${mapped.subject.replace(/[:@\s/]+/g, '-')}@school.local`;
  const name = mapped.name || mapped.subject;
  return {
    sub: mapped.subject,
    email,
    name,
    ...(mapped.schoolName ? { schoolName: mapped.schoolName } : {}),
    // 角色只在存在时挂上：不改变既有身份的字段形状（老单测/日志都按四字段比对）
    ...(mapped.roles.length > 0 ? { roles: mapped.roles } : {}),
  };
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 通用登录限制：按配置条件逐条校验，条件之间是「且」。
 *
 * - 未启用直接放行（默认行为）；
 * - 配置不完整（没有条件 / 条件缺值 / 自定义路径为空）视为配置错误，fail closed；
 * - 字段取不到值按未命中处理，不放行。
 */
export function assertLoginRestriction(
  auth: AppConfig['auth'],
  claims: Record<string, unknown>,
  mapped: MappedClaims
): void {
  const restrict = auth.restrict;
  if (!restrict.enabled) return;

  const conditions = restrict.conditions;
  if (conditions.length === 0) {
    throw new AuthFlowError('restrict_misconfigured', '登录限制配置不完整');
  }

  for (const condition of conditions) {
    const path = condition.path.trim();
    const expected = normalize(condition.value);
    if (!expected || (condition.field === 'custom' && !path)) {
      throw new AuthFlowError('restrict_misconfigured', '登录限制配置不完整');
    }

    // 单条条件内按该字段的候选值「任一命中」；多值字段（角色）才有多个候选
    const actual = conditionCandidates(condition.field, path, claims, mapped);
    if (!actual.includes(expected)) {
      throw new AuthFlowError('login_restricted', '该账号不在允许登录的范围内');
    }
  }
}

/** 某条条件作用字段的全部候选值（已 trim + 小写） */
function conditionCandidates(
  field: AppConfig['auth']['restrict']['conditions'][number]['field'],
  path: string,
  claims: Record<string, unknown>,
  mapped: MappedClaims
): string[] {
  let values: string[];
  switch (field) {
    case 'custom':
      values = collectValues(readClaimPath(claims, path));
      break;
    case 'roles':
      values = mapped.roles;
      break;
    case 'subject':
    case 'email':
    case 'name':
    case 'schoolCode':
    case 'schoolName':
      values = [mapped[field]];
      break;
    default:
      values = [];
      break;
  }
  return values.map(normalize).filter(Boolean);
}

/** 适配层统一入口：解析映射 → 校验登录限制 → 产出 Identity */
export function establishIdentity(input: {
  auth: AppConfig['auth'];
  claims: Record<string, unknown>;
  fieldMap?: Partial<OAuth2FieldMap>;
}): Identity {
  const mapped = resolveMappedClaims(input.claims, input.fieldMap);
  assertLoginRestriction(input.auth, input.claims, mapped);
  return toIdentity(mapped);
}
