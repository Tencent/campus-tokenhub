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

