/**
 * 管理员名单的可选身份（姓名 + `school_id:user_id`）。
 *
 * 来源只有两个：现有名单（保证已在名单里的人能展示与移除）与网关用户搜索
 * （= 登录过门户的人，含 `external_user_id`）。
 *
 * 与成员站（member）的差异：统一采买站没有申请单表，因此不存在「从申请记录补姓名」
 * 这一路；姓名只能从网关兜底邮箱里解析。
 *
 * `query` 为空时只取网关最近一页，绝不拉全量：学校可能有几千、几万人。
 * 名单里的人若不在这一页内，再按 `external_user_id` 逐个精确补齐姓名——
 * 否则列表里只剩 `school_id:user_id`，退化成「姓名未同步」。
 */

import type { GatewayClient } from '@/lib/gateway/client';
import { getGatewayClient } from '@/lib/gateway/client';
import { findUsersByExternalIds, searchGatewayUsers } from '@/lib/gateway/users';
import { isValidAdminSub, readAdminSubs, type AdminRosterRepo } from './roster';
import type { AdminCandidate } from './types';

/**
 * 从开户兜底邮箱里取姓名。
 *
 * `gatewayUserEmail` 在认证方不返回邮箱时拼的是 `{姓名}.{school_id}-{user_id}@school.local`，
 * 这里按最后一段的 `数字-数字` 识别 id 后缀；真实邮箱（`zhangsan@x.edu.cn`）取不到姓名，
 * 返回空串由调用方退化处理。
 */
export function nameFromGatewayEmail(email: string | null | undefined): string {
  const local = (email ?? '').trim().split('@')[0] ?? '';
  const dot = local.lastIndexOf('.');
  if (dot <= 0) return '';
  const suffix = local.slice(dot + 1);
  return /^\d+-\d+$/.test(suffix) ? local.slice(0, dot) : '';
}

export async function readAdminCandidates(input: {
  currentSub: string;
  /** 关键字：姓名 / 邮箱 / school_id:user_id；为空则给最近一页 */
  query?: string;
  limit?: number;
  client?: GatewayClient;
  repo?: AdminRosterRepo;
}): Promise<AdminCandidate[]> {
  const client = input.client ?? getGatewayClient();
  const query = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);

  const [{ subs }, search] = await Promise.all([
    readAdminSubs(input.repo),
    searchGatewayUsers({ query, limit }, client).catch(() => ({ users: [], total: 0 })),
  ]);

  type Raw = { sub: string; name: string; email: string | null };
  const merged = new Map<string, Raw>();

  const upsert = (sub: string | null | undefined, name: string, email: string | null): void => {
    const key = (sub ?? '').trim();
    if (!key || !isValidAdminSub(key)) return;
    const previous = merged.get(key);
    const nextName = name.trim() || previous?.name || '';
    const nextEmail = (email ?? '').trim() || previous?.email || null;
    merged.set(key, { sub: key, name: nextName, email: nextEmail });
  };

  // 初始候选（未输入关键字）才把名单项整体带上，保证页面列表能展示与移除已有管理员。
  // 搜索时只返回命中的网关用户：否则名单项会把 20 条候选全部占满，姓名只能靠本次命中
  // 补全，未命中的成员就退化成「姓名未同步」；同时搜索无结果也永远看不到空态。
  if (!query) {
    for (const sub of subs) upsert(sub, '', null);
    upsert(input.currentSub, '', null);
  }

  for (const user of search.users) upsert(user.external_user_id, '', user.email ?? null);

  // 名单项常常不在「网关最近一页」里（早于最近 20 个开户），姓名就永远解析不出来。
  // 合并完最近一页后再按 sub 精确补齐仍缺邮箱的名单项：名单规模是个位数，代价可控。
  if (!query) {
    const rosterSubs = new Set([...subs, (input.currentSub ?? '').trim()].filter(isValidAdminSub));
    const missing = [...merged.values()]
      .filter((item) => rosterSubs.has(item.sub) && !item.email)
      .map((item) => item.sub);
    const resolved = await findUsersByExternalIds(missing, client).catch(() => []);
    for (const user of resolved) upsert(user.external_user_id, '', user.email ?? null);
  }

  return [...merged.values()]
    .map((item) => ({
      sub: item.sub,
      name: item.name || nameFromGatewayEmail(item.email) || item.sub,
      email: item.email,
      listed: subs.includes(item.sub),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.sub.localeCompare(b.sub));
}
