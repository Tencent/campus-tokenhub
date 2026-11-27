/**
 * 配置校验：字段级（单值）+ 提交级（跨字段）。
 *
 * 接口与页面共用同一份规则：页面用它做失焦即时提示，接口用它做最后一道拦截。
 * 错误结构固定为 `{ key, message }`，key 是类型化字段 id。
 *
 * 与成员站（member）的差异：统一采买站没有门户模式开关，也没有腾讯云凭据，
 * 因此这里不再有「模式互斥」与「SecretId/SecretKey 成对」两段跨字段校验。
 * 目前只剩字段级校验，保留 `validateSettings` 这层是为了接口与页面的调用形状不变。
 */

import type { ConfigField, ConfigValue } from './fields';
import { validateField, type FieldError } from './validate-field';

export { validateField };
export type { FieldError };

/**
 * 整份校验：逐字段。
 *
 * `current` 预留给将来可能新增的跨字段规则（当前未使用）。
 */
export function validateSettings(
  values: Partial<Record<ConfigField, unknown>>,
  current: Partial<Record<ConfigField, ConfigValue>> = {}
): FieldError[] {
  void current;
  const errors: FieldError[] = [];

  for (const [field, raw] of Object.entries(values) as [ConfigField, unknown][]) {
    const error = validateField(field, raw);
    if (error) errors.push(error);
  }

  return errors;
}
