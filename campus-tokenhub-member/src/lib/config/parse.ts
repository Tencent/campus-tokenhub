/**
 * 配置值的基础解析工具。
 *
 * 从 `config.ts` 抽出，避免「env 解析」与「运行期配置注册表」各写一份逗号串/权限 ID 规则。
 */

export function toList(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/** 财务权限 ID 全集（腾讯云文档取值 1-10）。 */
export const PERMISSION_ID_MIN = 1;
export const PERMISSION_ID_MAX = 10;
/** 1、2 是腾讯云要求的必选权限（查看账单、查看余额）。 */
export const REQUIRED_PERMISSION_IDS = [1, 2] as const;
/**
 * 未配置时的默认权限：1 查看账单、2 查看余额、5 开票、6 优惠继承。
 *
 * 这四项覆盖成员账号日常对账，绝大多数学校不需要调整；
 * 3（资金划拨）、10（信用额度设置）需要商务单独开通，默认不开。
 */
export const DEFAULT_PERMISSION_IDS = [1, 2, 5, 6] as const;

/**
 * 解析财务权限 ID 列表：去重排序，取值必须落在 1-10，且包含腾讯云要求的 1、2。
 */
export function parsePermissionIds(raw: string): number[] {
  const items = toList(raw);
  if (items.length === 0) return [...DEFAULT_PERMISSION_IDS];

  const parsed: number[] = [];
  for (const item of items) {
    if (!/^\d+$/.test(item)) {
      throw new Error(`MEMBER_ACCOUNT_PERMISSION_IDS 只能是数字，当前包含 ${item}`);
    }
    const value = Number(item);
    if (value < PERMISSION_ID_MIN || value > PERMISSION_ID_MAX) {
      throw new Error(
        `MEMBER_ACCOUNT_PERMISSION_IDS 取值必须在 ${PERMISSION_ID_MIN}-${PERMISSION_ID_MAX}，当前是 ${value}`
      );
    }
    parsed.push(value);
  }

  const unique = [...new Set(parsed)].sort((a, b) => a - b);
  const missing = REQUIRED_PERMISSION_IDS.filter((id) => !unique.includes(id));
  if (missing.length > 0) {
    throw new Error(
      `MEMBER_ACCOUNT_PERMISSION_IDS 必须包含 1、2（查看账单、查看余额），当前缺少 ${missing.join('、')}`
    );
  }
  return unique;
}
