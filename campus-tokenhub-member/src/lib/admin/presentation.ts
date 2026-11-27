/**
 * 管理员候选列表的纯展示计算。
 *
 * 拆出来是为了能在 node 环境单测：组件只负责渲染，合并逻辑在这里。
 */

import type { AdminCandidate } from './types';

/**
 * 合并两批候选：已有的一批（含姓名）优先于新搜到的（只有 sub）。
 *
 * 规则：
 * - 新项没有姓名（name === sub）时，保留旧项已有的姓名；
 * - 邮箱取第一个非空值；
 * - 其余字段以新项为准。
 */
export function mergeAdminCandidates(
  current: AdminCandidate[],
  incoming: AdminCandidate[]
): AdminCandidate[] {
  const merged = new Map(current.map((item) => [item.sub, item]));

  for (const item of incoming) {
    const previous = merged.get(item.sub);
    if (!previous) {
      merged.set(item.sub, item);
      continue;
    }
    const previousNamed = previous.name !== previous.sub;
    merged.set(item.sub, {
      ...item,
      name: previousNamed ? previous.name : item.name,
      email: previous.email ?? item.email,
    });
  }

  return [...merged.values()];
}
