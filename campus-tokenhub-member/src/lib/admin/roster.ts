/**
 * 全局管理员名单（共享表 `portal_shared.admins`）。
 *
 * **只有一份数据**：两站同时部署时，任一侧增删管理员，另一侧下一次请求立即生效
 * （见 openspec design D4）。这也是它必须放在 `portal_shared` 而不是侧内 schema 的原因——
 * 放在各自 schema 里，Cookie 一旦过期重新登录，两边判定就会分叉。
 *
 * 名单是「全局管理员」的唯一来源：名单里的人能审核成员、进设置、用网关后台，也能维护名单本身。
 * 判定口径：只认名单；名单为空时由登录签发路径上的首登认领写入第一个管理员。
 */

import { ADMINS_TABLE } from '@/lib/config/tables';
import { getDb, withTransaction, type Db } from '@/lib/db/portal-db';
import { ensurePortalSchema } from '@/lib/db/portal-schema';

/** 最后一名全局管理员不能被移除：否则管理入口会整体失去归属 */
export class LastAdminError extends Error {
  constructor() {
    super('至少保留一名全局管理员');
    this.name = 'LastAdminError';
  }
}

export type AdminSubs = {
  /** 解析后的名单，顺序即展示顺序，已去重 */
  subs: string[];
  /** true = 名单里有人 */
  managed: boolean;
  /** true = 本次读数据库失败，名单按空处理 */
  degraded: boolean;
};

/** 存储实现：生产用 pg，测试可以换成内存实现 */
export type AdminRosterRepo = {
  list(): Promise<string[]>;
  replaceAll(subs: string[]): Promise<void>;
  add(subs: string[]): Promise<void>;
  remove(sub: string): Promise<void>;
};

/** `school_id:user_id` 逗号分隔串 → 去空白、去重、丢掉没有冒号或引导账号的脏项。 */
export function parseAdminSubs(raw: string | null | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.includes(':') && !isBootstrapLocalSub(item));
  return [...new Set(items)];
}

/** 引导期本地身份（见 `auth/local-admin.ts`）的固定前缀，不是 SSO 的 `school_id:user_id`。 */
const LOCAL_ADMIN_SUB_PREFIX = 'local:';

/** 该 sub 是否是引导期本地账号，而非 SSO 身份。 */
export function isBootstrapLocalSub(sub: string): boolean {
  return sub.trim().toLowerCase().startsWith(LOCAL_ADMIN_SUB_PREFIX);
}

/**
 * 单条身份的合法性：`school_id:user_id`，两段都非空且不含空白/逗号。
 *
 * 引导期本地身份 `local:<username>` 凭 env 凭据即管理员（见 `auth/local-admin.ts`），
 * 不进共享名单。`local:ops-admin` 恰好也匹配冒号格式，旧版本经 onboarding owner
 * 把它写进名单后，名单「非空」会挡住真实 SSO 用户的首登认领——这里显式排除，
 * 同时防止 API / 认领路径再次写入。
 */
export function isValidAdminSub(sub: string): boolean {
  const value = sub.trim();
  if (isBootstrapLocalSub(value)) return false;
  return /^[^:\s,]+:[^:\s,]+$/.test(value);
}

function normalizeSubs(subs: string[]): string[] {
  return parseAdminSubs(subs.join(','));
}

async function readyDb(): Promise<Db> {
  await ensurePortalSchema();
  return getDb();
}

function createPgRepo(): AdminRosterRepo {
  return {
    async list(): Promise<string[]> {
      const db = await readyDb();
      const { rows } = await db.query<{ sub: string }>(
        `SELECT sub FROM ${ADMINS_TABLE} ORDER BY created_at, sub`
      );
      return rows.map((row) => row.sub);
    },

    async replaceAll(subs: string[]): Promise<void> {
      await readyDb();
      await withTransaction(async (tx) => {
        await tx.query(`DELETE FROM ${ADMINS_TABLE}`);
        if (subs.length > 0) {
          await tx.query(
            `INSERT INTO ${ADMINS_TABLE} (sub)
             SELECT unnest($1::text[]) ON CONFLICT (sub) DO NOTHING`,
            [subs]
          );
        }
      });
    },

    async add(subs: string[]): Promise<void> {
      if (subs.length === 0) return;
      const db = await readyDb();
      await db.query(
        `INSERT INTO ${ADMINS_TABLE} (sub)
         SELECT unnest($1::text[]) ON CONFLICT (sub) DO NOTHING`,
        [subs]
      );
    },

    async remove(sub: string): Promise<void> {
      const db = await readyDb();
      await withTransaction(async (tx) => {
        // 串行化：两个人同时互删时，后到的一定能看到对方的结果
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('portal_shared_admin_roster'))");
        const { rows } = await tx.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM ${ADMINS_TABLE}`
        );
        if ((rows[0]?.count ?? 0) <= 1) throw new LastAdminError();
        await tx.query(`DELETE FROM ${ADMINS_TABLE} WHERE sub = $1`, [sub]);
      });
    },
  };
}

/** 当前仓库实现；测试可整体替换为内存实现 */
let currentRepo: AdminRosterRepo = createPgRepo();
/** 仓储是否被测试替换；首登认领据此选择实现 */
let usingRepoOverride = false;

export function setAdminRosterRepoOverride(repo: AdminRosterRepo | null): void {
  currentRepo = repo ?? createPgRepo();
  // 认领要跟着同一份实现走：否则单测注入内存名单后，认领仍会去打真库并静默失败，
  // 测试断言就会与线上行为分叉（线上首登是管理员，测试里却不是）。
  usingRepoOverride = repo !== null;
}

/**
 * 读当前生效的管理员名单。
 *
 * 数据库异常不抛：管理员判定是「能不能点按钮」的前置条件，让它 500 会把整个页面带崩。
 */
export async function readAdminSubs(repo: AdminRosterRepo = currentRepo): Promise<AdminSubs> {
  try {
    // 历史脏数据里可能有引导账号（local:ops-admin）：它不是 SSO 身份、不占管理员名额，
    // 统一从读取结果里剔除，避免挡住首登认领，也避免误显示成「已有管理员」。
    const subs = (await repo.list()).filter((item) => !isBootstrapLocalSub(item));
    return { subs, managed: subs.length > 0, degraded: false };
  } catch {
    return { subs: [], managed: false, degraded: true };
  }
}

/** 覆盖写整份名单；返回归一化后的结果。 */
export async function writeAdminSubs(
  subs: string[],
  repo: AdminRosterRepo = currentRepo
): Promise<string[]> {
  const normalized = normalizeSubs(subs);
  await repo.replaceAll(normalized);
  return normalized;
}

/**
 * 追加若干身份。
 *
 * 只写缺的那些（`ON CONFLICT DO NOTHING`），无新增时连写都不发。
 */
export async function addAdmins(
  entries: string[],
  repo: AdminRosterRepo = currentRepo
): Promise<string[]> {
  const incoming = [...new Set(entries.map((item) => item.trim()).filter(Boolean))];
  for (const entry of incoming) {
    if (!isValidAdminSub(entry)) {
      throw new Error('管理员身份格式应为 school_id:user_id');
    }
  }

  const { subs } = await readAdminSubs(repo);
  if (incoming.length === 0) return subs;

  const missing = incoming.filter((entry) => !subs.includes(entry));
  if (missing.length === 0) return subs;

  await repo.add(missing);
  return (await readAdminSubs(repo)).subs;
}

/** 追加一个身份（单选添加时的便捷入口） */
export async function addAdmin(
  sub: string,
  repo: AdminRosterRepo = currentRepo
): Promise<string[]> {
  return addAdmins([sub], repo);
}

/** 移除一个身份；最后一名管理员不允许移除。 */
export async function removeAdmin(
  sub: string,
  repo: AdminRosterRepo = currentRepo
): Promise<string[]> {
  const entry = sub.trim();
  const subs = await repo.list();
  if (subs.includes(entry) && subs.length <= 1) throw new LastAdminError();
  await repo.remove(entry);
  return (await readAdminSubs(repo)).subs;
}

/** 「名单非空」的进程内标记：认领分支不必每次都 count(*) */
let knownNonEmpty = false;

export function resetAdminRosterCache(): void {
  knownNonEmpty = false;
}

/**
 * 名单为空时，把首个合法登录者认领为管理员。
 *
 * 三条约束：
 * 1. 只接受 `school_id:user_id`（邮箱 / 纯数字身份不写进名单，避免不可靠身份获得管理权）；
 * 2. 锁名固定为 `portal_shared_admin_claim`——**两侧必须完全相同**，否则双站同时首登会各认领一个，
 *    直接违背「管理员一套」；
 * 3. 写库异常按「未认领」处理，不抛错（登录不能因为认领失败而失败）。
 */
export async function claimFirstAdmin(sub: string): Promise<boolean> {
  if (!isValidAdminSub(sub)) return false;
  if (knownNonEmpty) return false;

  // 仓储被替换（测试注入内存实现）：没有事务与 advisory lock，但「名单为空才写」的口径不变。
  // 只看真实 SSO 身份：历史版本曾把 local:ops-admin 写进名单，那条是引导账号、
  // 不代表「已有管理员」，不能挡住首个真实登录者认领。
  if (usingRepoOverride) {
    try {
      const subs = (await currentRepo.list()).filter((item) => !isBootstrapLocalSub(item));
      if (subs.length > 0) {
        knownNonEmpty = true;
        return false;
      }
      await currentRepo.add([sub]);
      knownNonEmpty = true;
      return true;
    } catch {
      return false;
    }
  }

  try {
    const claimed = await withTransaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('portal_shared_admin_claim'))");

      // 与内存分支同一口径：排除引导账号，避免历史脏数据让首登认领永久失效。
      const { rows } = await tx.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM ${ADMINS_TABLE} WHERE lower(sub) NOT LIKE 'local:%'`
      );
      if ((rows[0]?.count ?? 0) > 0) return false;

      const inserted = await tx.query<{ sub: string }>(
        `INSERT INTO ${ADMINS_TABLE} (sub) VALUES ($1) ON CONFLICT (sub) DO NOTHING RETURNING sub`,
        [sub]
      );
      return inserted.rows.length > 0;
    });

    if (claimed) knownNonEmpty = true;
    return claimed;
  } catch {
    return false;
  }
}

/** 测试用：忘掉「名单非空」标记 */
export function resetAdminClaimCacheForTests(): void {
  knownNonEmpty = false;
}
