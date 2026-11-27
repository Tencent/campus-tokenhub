/** 用户的 get-or-create / 反查 / 详情。 */

import { getConfig } from '@/lib/config';
import { readDefaultRateLimit, toGatewayRateLimit } from '@/lib/config/quota';
import { getGatewayClient, type GatewayClient } from './client';
import type { GatewayListResponse, GatewayUser } from './types';
import type { Identity } from '@/lib/auth/providers/types';

export type ProvisionResult =
  | { ok: true; octafuseUserId: string }
  | { ok: false; error: string };

/** 外部 ID 归一化成邮箱本地部分：`100051:10131002` → `100051-10131002` */
function idSuffix(identity: Identity): string {
  return identity.sub.replace(/[:@\s]+/g, '-');
}

/**
 * 只有 ID 的占位邮箱（`100051-10131002@school.local`）。
 *
 * 认证方不返回邮箱时，`toIdentity()` 会派生出这个地址占位，它**不代表真实邮箱**。
 * 开户时必须当成「没有邮箱」处理，否则 `gatewayUserEmail()` 走早返回分支，
 * 姓名永远拼不进去（配置化改造把兜底从 provider 挪进 `toIdentity()` 后踩过这个坑）。
 */
function isPlaceholderEmail(identity: Identity): boolean {
  const email = (identity.email ?? '').trim().toLowerCase();
  if (!email) return true;
  return (
    email === `${idSuffix(identity)}@school.local`.toLowerCase() ||
    // 早期兜底用的是带冒号的原始 sub
    email === `${identity.sub}@school.local`.toLowerCase()
  );
}

/** 可用的姓名：`toIdentity()` 会把 name 兜底成 sub，纯 ID 不能拼进邮箱 */
function usableName(identity: Identity): string {
  const name = (identity.name ?? '').trim();
  if (!name || name === identity.sub) return '';
  if (/^[\d:\-_.@\s]+$/.test(name)) return '';
  // 邮箱 local part 不能带空白：`张 亮` → `张亮`；冒号会破坏「数字-数字」后缀约定，换成短横
  return name.replace(/\s+/g, '').replace(/[:@]+/g, '-');
}

/**
 * 开户用的邮箱。
 *
 * 网关 `users` 表只有 `email`（同一 `external_system` 内唯一）和 `metadata`，**没有姓名字段**，
 * 管理台请求日志的「用户」列展示的就是这个 email。aie 不返回邮箱，原来兜底成 `{sub}@school.local`，
 * 管理员在日志里只能看到 `100094:17908` 这种 id。这里把姓名拼进去，日志里就能认出是谁：
 * `张三.100094-17908@school.local`。带 sub 后缀是为了同名学生不撞唯一索引。
 *
 * 有真实邮箱时（mock / OIDC 登录）保持原样；身份层派生出来的占位邮箱按「没有邮箱」重拼。
 */
export function gatewayUserEmail(identity: Identity): string {
  const email = identity.email?.trim();
  if (email && !isPlaceholderEmail(identity)) return email;
  const suffix = idSuffix(identity);
  const name = usableName(identity);
  return name ? `${name}.${suffix}@school.local` : `${suffix}@school.local`;
}

/** 历史兜底邮箱（只有 id、没有姓名），用于登录时顺手改成带姓名的版本。 */
function legacyFallbackEmail(identity: Identity): string {
  return `${idSuffix(identity)}@school.local`.toLowerCase();
}

/**
 * 网关里存的是不是「只有 id」的老邮箱。
 *
 * 存量两种形状都要认：短横版（现口径 `100051-10131002@school.local`）与早期的冒号版
 * （`100051:10131002@school.local`）。之前只比冒号版，短横版永远不命中，补姓名从来没生效。
 */
function isLegacyFallbackEmail(identity: Identity, current: string | null | undefined): boolean {
  const value = (current ?? '').trim().toLowerCase();
  if (!value) return false;
  return (
    value === legacyFallbackEmail(identity) ||
    value === `${identity.sub}@school.local`.toLowerCase()
  );
}

/**
 * 按 `(external_system, external_user_id)` 幂等开户。
 *
 * 网关语义：已存在时返回 200 + 已有对象，所以不需要先查后建，也不怕并发。
 * 失败**不抛异常**（design D5），交给调用方决定「账号开通中」的展示。
 */
export async function provisionUser(
  identity: Identity,
  client: GatewayClient = getGatewayClient()
): Promise<ProvisionResult> {
  const cfg = getConfig();
  const rateLimit = toGatewayRateLimit(readDefaultRateLimit(cfg));

  try {
    const response = await client.admin<{
      success?: boolean;
      data?: { id?: string; email?: string | null };
    }>('/api/admin/users', {
      method: 'POST',
      body: {
        email: gatewayUserEmail(identity),
        external_system: cfg.octafuse.externalSystem,
        external_user_id: identity.sub,
        budget_max: cfg.defaults.budgetMax,
        budget_period: cfg.defaults.budgetPeriod,
        // 只在网关「真正建号」时生效；已存在用户原样返回，不会覆盖管理员后来调过的限流
        ...(rateLimit ? { rate_limit: rateLimit } : {}),
      },
    });

    const id = response?.data?.id;
    if (!id) return { ok: false, error: '网关未返回用户 ID' };

    await upgradeLegacyEmail(id, response?.data?.email, identity, client);
    return { ok: true, octafuseUserId: id };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '开户失败' };
  }
}

/**
 * 老账号是 `{sub}@school.local`（只有 id）：登录时顺手改成带姓名的邮箱，管理台日志才认得出人。
 *
 * 开户接口对已存在用户是「原样返回、不更新」，所以只能补一次 PATCH。改名失败（例如同名学生
 * 已占用该邮箱）不影响登录，也不阻断开户结论。
 */
async function upgradeLegacyEmail(
  userId: string,
  currentEmail: string | null | undefined,
  identity: Identity,
  client: GatewayClient
): Promise<void> {
  if (!isPlaceholderEmail(identity)) return;
  if (!usableName(identity)) return;
  if (!isLegacyFallbackEmail(identity, currentEmail)) return;

  const current = (currentEmail ?? '').trim().toLowerCase();
  const email = gatewayUserEmail(identity);
  if (email.toLowerCase() === current) return;

  try {
    await client.admin(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: { email },
    });
  } catch {
    // 邮箱被占用 / 网关拒绝时保持旧值，不影响登录
  }
}

export async function findByExternalId(
  externalUserId: string,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayUser | null> {
  const cfg = getConfig();
  const response = await client.admin<GatewayListResponse<GatewayUser>>('/api/admin/users', {
    query: {
      external_system: cfg.octafuse.externalSystem,
      external_user_id: externalUserId,
      page_size: 1,
    },
  });

  const users = response?.data ?? [];
  const exact = users.find((user) => user.external_user_id === externalUserId);
  return exact ?? users[0] ?? null;
}

export async function getUser(
  userId: string,
  client: GatewayClient = getGatewayClient()
): Promise<GatewayUser> {
  const response = await client.admin<{ data: GatewayUser }>(`/api/admin/users/${encodeURIComponent(userId)}`);
  if (!response?.data) throw new Error('网关未返回用户详情');
  return response.data;
}

/** 候选搜索的默认条数；学校几千、几万人时不拉全量，只按关键字取一小页。 */
const USER_SEARCH_PAGE_SIZE = 20;
/** 名单补姓名的并发上限：名单通常只有几个人，避免一串请求同时打到网关。 */
const USER_LOOKUP_CONCURRENCY = 4;
/** 网关单页硬上限（`users.impl.ts` 里 clamp 到 100）。 */
const USER_MAX_PAGE_SIZE = 100;

export type GatewayUserSearch = {
  users: GatewayUser[];
  /** 网关侧匹配总数，用于提示「还有更多，请补充关键字」 */
  total: number;
};

/**
 * 按 `external_user_id` 批量查用户，用于给管理员名单补姓名。
 *
 * 候选初始只取网关最近一页（`USER_SEARCH_PAGE_SIZE`），名单里的早期账号常常不在其中，
 * 展示名就只剩 `school_id:user_id`。这里对名单逐个精确查（网关 `external_user_id`
 * 精确匹配），命中后调用方可以从兜底邮箱解析出姓名。
 *
 * 名单规模是个位数，代价可控；单个查询失败按未命中处理——补姓名是锦上添花，
 * 不能因为某个账号查不到就拖垮整份名单的展示。
 */
export async function findUsersByExternalIds(
  externalUserIds: readonly string[],
  client: GatewayClient = getGatewayClient()
): Promise<GatewayUser[]> {
  const ids = [...new Set(externalUserIds.map((id) => (id ?? '').trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const found: GatewayUser[] = [];
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (cursor < ids.length) {
      const id = ids[cursor];
      cursor += 1;
      if (!id) continue;
      try {
        const user = await findByExternalId(id, client);
        if (user) found.push(user);
      } catch {
        // 网关抖动/超时：这一项不补姓名，其余照常
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(USER_LOOKUP_CONCURRENCY, ids.length) }, () => worker())
  );
  return found;
}

/**
 * 按关键字搜索网关用户，供「选人」场景使用（管理员名单候选）。
 *
 * 关键字匹配网关的 `email`（LIKE `%q%`）：本地部署的 email 形如
 * `姓名.school_id-user_id@school.local`，所以中文姓名、数字 ID 都能搜到。
 * 关键字是 `school_id:user_id` 时额外按 `external_user_id` 精确查一次——
 * 现代账号的 email 用 `-` 连接，只按 email 搜 `100051:1012173` 会漏。
 *
 * 关键字为空时返回最近创建的一页，作为「还没输入时」的默认候选。
 * 任何失败由调用方降级：这里不吞错，调用方决定是否空列表。
 */
export async function searchGatewayUsers(
  input: { query?: string; limit?: number } = {},
  client: GatewayClient = getGatewayClient()
): Promise<GatewayUserSearch> {
  const cfg = getConfig();
  const query = input.query?.trim() ?? '';
  const limit = Math.min(Math.max(input.limit ?? USER_SEARCH_PAGE_SIZE, 1), USER_MAX_PAGE_SIZE);

  const fetchPage = (extra: { email?: string; externalUserId?: string }) =>
    client.admin<GatewayListResponse<GatewayUser>>('/api/admin/users', {
      query: {
        external_system: cfg.octafuse.externalSystem,
        ...(extra.email ? { email: extra.email } : {}),
        ...(extra.externalUserId ? { external_user_id: extra.externalUserId } : {}),
        page: 1,
        page_size: limit,
      },
    });

  const tasks = [fetchPage({ email: query || undefined })];
  if (/^[^:\s,]+:[^:\s,]+$/.test(query)) tasks.push(fetchPage({ externalUserId: query }));

  const pages = await Promise.all(tasks);
  const merged = new Map<string, GatewayUser>();
  for (const page of pages) {
    for (const user of page?.data ?? []) merged.set(user.id, user);
  }

  const users = [...merged.values()];
  const total = pages.reduce(
    (max, page) => Math.max(max, typeof page?.total === 'number' ? page.total : 0),
    users.length
  );

  return { users: users.slice(0, limit), total };
}
