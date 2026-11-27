/**
 * 单字段校验（浏览器可用）。
 *
 * 字段 id 来自 `fields.ts` 的联合类型，拼错 key 在编译期就会报错；
 * 这里只做字段级格式校验，跨字段规则在 `validate.ts`。
 */

import { ConfigValueError, toConfigValue, type ConfigField } from './fields';

export type FieldError = { key: ConfigField; message: string };

/** 字段级校验：只返回字段 id 与中文错误，不抛异常 */
export function validateField(field: ConfigField, raw: unknown): FieldError | null {
  try {
    toConfigValue(field, raw);
    return null;
  } catch (error) {
    if (error instanceof ConfigValueError) return { key: field, message: error.message };
    throw error;
  }
}
