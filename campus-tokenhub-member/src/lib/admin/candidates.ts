/**
 * 管理员名单的可选身份（姓名 + `school_id:user_id`）。
 *
 * 来源三个：现有名单（保证已在名单里的人能展示与移除）、成员申请记录、
 * 以及共享库里的网关用户表（只读补姓名）。
 *
 * 网关用户表是唯一覆盖存量管理员的姓名来源：登录时认证方给的名字被拼进
 * `{姓名}.{school_id}-{user_id}@school.local`，两站共库部署时成员站可以直接读到。
 * 单站部署没有这张表，查询失败即降级，姓名退回申请记录 / ID，功能不受影响。
 *
 * 与统一采买站（assign）的差异：那边通过网关 API 搜人，这里只读共享库里的用户表，
 * 不引入网关客户端，也不写任何网关数据。
 *
 * 申请记录本身有学校规模上限（一人一单），但这里仍按关键字过滤，不整份返回。
 */

import { getDb, type Db } from '@/lib/db/portal-db';
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

/** 网关用户表补出来的姓名条目 */
export type GatewayDisplayName = { sub: string; name: string; email: string | null };

/** 可注入的姓名来源：测试塞内存实现，线上走共享库只读查询 */
export type UserDirectory = (subs: string[]) => Promise<GatewayDisplayName[]>;

/**
 * 按管理员 sub 批量读共享库里的网关用户姓名。
 *
 * 只在初始名单展示时调用：按 `external_user_id` 精确匹配，不拉全表；
 * 同一 sub 在多个 external_system 下都有记录时，优先取能解析出姓名的邮箱。
 * 任何失败（单站部署没有这个 schema / 数据库抖动）都降级为空，
 * 让姓名退回申请记录或 ID，绝不影响名单展示与增删。
 */
export async function readGatewayDisplayNames(subs: string[], db?: Db): Promise<GatewayDisplayName[]> {
  if (subs.length === 0) return [];
  try {
    const handle = db ?? getDb();
    const { rows } = await handle.query<{ sub: string; email: string | null }>(
      `SELECT external_user_id AS sub, email
         FROM octafuse_gateway.users
        WHERE external_user_id = ANY($1::text[])
          AND email IS NOT NULL`,
      [subs]
    );

    const bySub = new Map<string, GatewayDisplayName>();
    for (const row of rows) {
      const sub = (row.sub ?? '').trim();
      const name = nameFromGatewayEmail(row.email);
      if (!sub || !name) continue;
      const previous = bySub.get(sub);
      if (!previous || (!previous.name && name)) {
        bySub.set(sub, { sub, name, email: row.email });
      }
    }
    return [...bySub.values()];
  } catch {
    return [];
  }
}

/** 申请单来源的最小形状：只需要这三个字段，避免把整个 store 拖进纯展示层 */
export type AdminCandidateApplications = () => Promise<
  { applicantSub: string; applicantName: string | null; email: string | null }[]
>;

export async function readAdminCandidates(input: {
  currentSub: string;
  /** 关键字：姓名 / 邮箱 / school_id:user_id；为空则给最近一页 */
  query?: string;
  /** 申请单来源（默认读门户数据库，测试可注入） */
  applications?: AdminCandidateApplications;
  /** 网关姓名来源（默认只读共享库的用户表，测试可注入） */
  userDirectory?: UserDirectory;
  repo?: AdminRosterRepo;
}): Promise<AdminCandidate[]> {
  const query = (input.query ?? '').trim();

  const loadApplications: AdminCandidateApplications =
    input.applications ??
    (async () => {
      const { readStore } = await import('@/lib/members/store');
      const rows = await readStore();
      return rows.map((row) => ({
        applicantSub: row.applicantSub,
        applicantName: row.applicantName ?? null,
        email: row.email ?? null,
      }));
    });

  const [{ subs }, applications] = await Promise.all([
    readAdminSubs(input.repo),
    loadApplications().catch(() => []),
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

  // 申请记录只在「命中关键字」或「本身就在名单里」时并入，避免把整份申请历史塞进候选
  for (const app of applications) {
    const hit = query
      ? (app.applicantName ?? '').includes(query) || app.applicantSub.includes(query)
      : subs.includes(app.applicantSub);
    if (hit) upsert(app.applicantSub, app.applicantName ?? '', app.email ?? null);
  }

  // 初始候选（未输入关键字）才把名单项整体带上，保证页面列表能展示与移除已有管理员。
  // 搜索时只返回命中的申请记录：否则名单项会把候选全部占满，搜索无结果也看不到空态。
  // 网关姓名放在最后并入，优先级高于申请记录——它是登录时由认证方姓名拼出来的。
  if (!query) {
    for (const sub of subs) upsert(sub, '', null);
    upsert(input.currentSub, '', null);

    const directory = await (input.userDirectory ?? readGatewayDisplayNames)(
      [...new Set([...subs, input.currentSub])]
    ).catch(() => []);
    for (const user of directory) upsert(user.sub, user.name, user.email);
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
