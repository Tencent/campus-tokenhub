/**
 * 配置校验：字段级（单值）+ 提交级（跨字段）。
 *
 * 接口与页面共用同一份规则：页面用它做失焦即时提示，接口用它做最后一道拦截。
 * 错误结构固定为 `{ key, message }`，key 是类型化字段 id。
 */

import type { ConfigField, ConfigValue } from './fields';
import { validateField, type FieldError } from './validate-field';

export { validateField };
export type { FieldError };

/**
 * 整份校验：先逐字段，再做跨字段。
 *
 * `current` 是「当前已生效值」，用于跨字段校验时补全本次没提交的字段。
 */
export function validateSettings(
  values: Partial<Record<ConfigField, unknown>>,
  current: Partial<Record<ConfigField, ConfigValue>> = {}
): FieldError[] {
  const errors: FieldError[] = [];
  const merged: Partial<Record<ConfigField, unknown>> = { ...current, ...values };

  for (const [field, raw] of Object.entries(values) as [ConfigField, unknown][]) {
    const error = validateField(field, raw);
    if (error) errors.push(error);
  }

  // 腾讯云凭据必须成对
  const secretId = String(merged.tencentSecretId ?? '').trim();
  const secretKey = String(merged.tencentSecretKey ?? '').trim();
  if (Boolean(secretId) !== Boolean(secretKey)) {
    errors.push({
      key: secretId ? 'tencentSecretKey' : 'tencentSecretId',
      message: 'SecretId 与 SecretKey 必须成对填写',
    });
  }

  return errors;
}
