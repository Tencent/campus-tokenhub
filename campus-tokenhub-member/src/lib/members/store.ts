/**
 * 成员账号申请单：门户自己的 `portal_member.member_applications` 表（一行一张单）。
 *
 * 历史：早期是 `PORTAL_DATA_DIR/member-applications.json` 单文件存储（原子写 + 进程内锁），
 * 只在单副本部署下成立。改成表之后多副本安全，也能直接按状态/部门查。
 *
 * 兼容：
 * - 对外仍然只有 `readStore()` / `mutateStore()` 两个入口，路由层不用改；
 * - `mutateStore` 是「读全量 → 改 → 整份写回」，与文件时代语义一致（行数在百级以内）；
 * - 首次启动会把旧 JSON 一次性导入（`portal.settings` 记标记），之后只认表。
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from '@/lib/config';
import { getDb, withTransaction, type Db } from '@/lib/db/portal-db';
import { ensurePortalSchema, readSetting, writeSetting } from '@/lib/db/portal-schema';
import { MemberStoreError, type MemberApplication } from './types';

export { MemberStoreError } from './types';

const FILE_NAME = 'member-applications.json';
/** 单条申请单保留的状态轨迹条数 */
const EVENT_LIMIT = 20;
/** 申请单写入的跨实例互斥键（advisory lock） */
const MEMBER_STORE_LOCK_KEY = 728_001;
/** 迁移完成标记（`portal.settings`），不是业务数据 */
const APPLICATIONS_SEEDED_KEY = 'member_applications_initialized';

function resolveDataDir(dataDir?: string): string {
  return dataDir ?? getConfig().portalDataDir;
}

/** 旧 JSON 文件路径；只用于一次性导入与排障。 */
export function storeFilePath(dataDir?: string): string {
  return path.join(resolveDataDir(dataDir), FILE_NAME);
}

function normalize(app: MemberApplication): MemberApplication {
  return app.events.length > EVENT_LIMIT
    ? { ...app, events: app.events.slice(-EVENT_LIMIT) }
    : app;
}

/** 就地裁剪 events，保证进存储与出存储的记录都不会无限膨胀 */
function trimEventsInPlace(apps: MemberApplication[]): void {
  for (const app of apps) {
    if (app.events.length > EVENT_LIMIT) app.events = app.events.slice(-EVENT_LIMIT);
  }
}

/** 存储实现：生产用 pg，测试可以换成内存实现 */
export type MemberApplicationRepo = {
  read(): Promise<MemberApplication[]>;
  mutate<T>(fn: (apps: MemberApplication[]) => T | Promise<T>): Promise<T>;
};

type ApplicationRow = {
  id: string;
  applicant_sub: string;
  applicant_name: string;
  user_id: number;
  member_name: string;
  email: string;
  country_code: string;
  phone: string;
  department_path: string;
  resolved_node_id: number | null;
  resolved_node_path: string | null;
  remark: string;
  status: string;
  uin: string | null;
  error_code: string | null;
  error_message: string | null;
  tencent_request_id: string | null;
  review_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  provisioning_started_at: string | null;
  removing_started_at: string | null;
  deleted_at: string | null;
  delete_request_id: string | null;
  delete_error: string | null;
  last_attempt_at: string | null;
  revision: number;
  events: unknown;
  created_at: string;
  updated_at: string;
};

function rowToApplication(row: ApplicationRow): MemberApplication {
  return {
    id: row.id,
    applicantSub: row.applicant_sub,
    applicantName: row.applicant_name,
    userId: Number(row.user_id),
    memberName: row.member_name,
    email: row.email,
    countryCode: row.country_code,
    phone: row.phone,
    departmentPath: row.department_path ?? '',
    resolvedNodeId: row.resolved_node_id === null ? null : Number(row.resolved_node_id),
    resolvedNodePath: row.resolved_node_path,
    remark: row.remark ?? '',
    status: row.status as MemberApplication['status'],
    uin: row.uin,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    tencentRequestId: row.tencent_request_id,
    reviewNote: row.review_note,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    provisioningStartedAt: row.provisioning_started_at,
    removingStartedAt: row.removing_started_at ?? null,
    deletedAt: row.deleted_at ?? null,
    deleteRequestId: row.delete_request_id ?? null,
    deleteError: row.delete_error ?? null,
    lastAttemptAt: row.last_attempt_at,
    revision: Number(row.revision ?? 0),
    events: Array.isArray(row.events) ? (row.events as MemberApplication['events']) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const SELECT_ALL = `
  SELECT id, applicant_sub, applicant_name, user_id, member_name, email, country_code, phone,
         department_path, resolved_node_id, resolved_node_path, remark, status, uin,
         error_code, error_message, tencent_request_id, review_note, reviewed_by,
         reviewed_at, provisioning_started_at, removing_started_at, deleted_at,
         delete_request_id, delete_error, last_attempt_at, revision, events, created_at, updated_at
    FROM portal_member.member_applications
   ORDER BY created_at, id`;

const UPSERT_APPLICATION = `
  INSERT INTO portal_member.member_applications (
    id, applicant_sub, applicant_name, user_id, member_name, email, country_code, phone,
    department_path, resolved_node_id, resolved_node_path, remark, status, uin,
    error_code, error_message, tencent_request_id, review_note, reviewed_by,
    reviewed_at, provisioning_started_at, removing_started_at, deleted_at,
    delete_request_id, delete_error, last_attempt_at, revision, events, created_at, updated_at
  ) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8,
    $9, $10, $11, $12, $13, $14,
    $15, $16, $17, $18, $19,
    $20, $21, $22, $23, $24, $25,
    $26, $27, $28::jsonb, $29, $30
  ) ON CONFLICT (id) DO UPDATE SET
    applicant_sub = EXCLUDED.applicant_sub,
    applicant_name = EXCLUDED.applicant_name,
    user_id = EXCLUDED.user_id,
    member_name = EXCLUDED.member_name,
    email = EXCLUDED.email,
    country_code = EXCLUDED.country_code,
    phone = EXCLUDED.phone,
    department_path = EXCLUDED.department_path,
    resolved_node_id = EXCLUDED.resolved_node_id,
    resolved_node_path = EXCLUDED.resolved_node_path,
    remark = EXCLUDED.remark,
    status = EXCLUDED.status,
    uin = EXCLUDED.uin,
    error_code = EXCLUDED.error_code,
    error_message = EXCLUDED.error_message,
    tencent_request_id = EXCLUDED.tencent_request_id,
    review_note = EXCLUDED.review_note,
    reviewed_by = EXCLUDED.reviewed_by,
    reviewed_at = EXCLUDED.reviewed_at,
    provisioning_started_at = EXCLUDED.provisioning_started_at,
    removing_started_at = EXCLUDED.removing_started_at,
    deleted_at = EXCLUDED.deleted_at,
    delete_request_id = EXCLUDED.delete_request_id,
    delete_error = EXCLUDED.delete_error,
    last_attempt_at = EXCLUDED.last_attempt_at,
    revision = EXCLUDED.revision,
    events = EXCLUDED.events,
    created_at = EXCLUDED.created_at,
    updated_at = EXCLUDED.updated_at`;

function insertParams(app: MemberApplication): unknown[] {
  return [
    app.id,
    app.applicantSub,
    app.applicantName,
    app.userId,
    app.memberName,
    app.email,
    app.countryCode,
    app.phone,
    app.departmentPath ?? '',
    app.resolvedNodeId ?? null,
    app.resolvedNodePath ?? null,
    app.remark ?? '',
    app.status,
    app.uin,
    app.errorCode,
    app.errorMessage,
    app.tencentRequestId,
    app.reviewNote,
    app.reviewedBy,
    app.reviewedAt,
    app.provisioningStartedAt,
    app.removingStartedAt ?? null,
    app.deletedAt ?? null,
    app.deleteRequestId ?? null,
    app.deleteError ?? null,
    app.lastAttemptAt,
    app.revision ?? 0,
    JSON.stringify(app.events ?? []),
    app.createdAt,
    app.updatedAt,
  ];
}

function wrapError(action: string, error: unknown): MemberStoreError {
  if (error instanceof MemberStoreError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new MemberStoreError(`${action}失败：${detail}`);
}

async function selectAll(db: Db): Promise<MemberApplication[]> {
  try {
    const { rows } = await db.query<ApplicationRow>(SELECT_ALL);
    return rows.map(rowToApplication);
  } catch (error) {
    throw wrapError('读取申请单', error);
  }
}

/** 变更检测用的稳定签名：字段顺序固定，避免「内容没变但键序变了」被判成变更。 */
function signatureOf(app: MemberApplication): string {
  return JSON.stringify(normalize(app));
}

/**
 * 只写变更行。
 *
 * 早期实现是「删全表 + 逐行重插」，行数一多每次审核就要几十~几百次往返，
 * 而且把没改过的行（含 `events` JSONB）全部重写。现在按 id 做 upsert 差分：
 * - 新增：INSERT ... ON CONFLICT DO UPDATE；
 * - 修改：同上，只重写真正变了的行；
 * - 删除：一次 `NOT (id = ANY(...))` 兜底。
 */
async function applyDiff(
  db: Db,
  apps: MemberApplication[],
  beforeSignatures: Map<string, string>
): Promise<void> {
  try {
    const ids = apps.map((app) => app.id);
    await db.query(
      'DELETE FROM portal_member.member_applications WHERE NOT (id = ANY($1::text[]))',
      [ids]
    );
    for (const app of apps) {
      const normalized = normalize(app);
      if (beforeSignatures.get(normalized.id) === signatureOf(normalized)) continue;
      await db.query(UPSERT_APPLICATION, insertParams(normalized));
    }
  } catch (error) {
    throw wrapError('写入申请单', error);
  }
}

async function ready(): Promise<void> {
  try {
    await ensurePortalSchema();
  } catch (error) {
    throw wrapError('连接数据库', error);
  }
  await seedFromJsonOnce();
}

let seeding: Promise<void> | null = null;

/**
 * 一次性把旧 JSON 文件导进表里。
 *
 * - 文件不存在：只写标记（新部署没有历史数据）；
 * - 文件损坏：不写标记、不改文件，下次进程启动再试（数据还在盘上，避免静默清空）。
 */
function seedFromJsonOnce(): Promise<void> {
  if (!seeding) {
    seeding = seedFromJson().catch((error: unknown) => {
      seeding = null;
      throw error;
    });
  }
  return seeding;
}

async function seedFromJson(): Promise<void> {
  const db = getDb();
  if (await readSetting(db, APPLICATIONS_SEEDED_KEY)) return;

  let legacy: MemberApplication[] = [];
  try {
    const raw = await readFile(storeFilePath(), 'utf8');
    if (raw.trim()) legacy = parseLegacyFile(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // 文件存在但读不出来 / 解析失败：保留文件，下次再试
      console.error('[members] 旧申请单文件迁移失败，暂不写标记', error);
      return;
    }
  }

  await withTransaction(async (tx) => {
    if (await readSetting(tx, APPLICATIONS_SEEDED_KEY)) return;
    const { rows } = await tx.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM portal_member.member_applications'
    );
    if ((rows[0]?.count ?? 0) === 0 && legacy.length > 0) {
      for (const app of legacy) await tx.query(UPSERT_APPLICATION, insertParams(normalize(app)));
    }
    await writeSetting(tx, APPLICATIONS_SEEDED_KEY, new Date().toISOString());
  });
}

/** 旧文件结构 → 领域对象；缺字段按空值兜底，脏记录跳过而不是整份失败。 */
export function parseLegacyFile(raw: string): MemberApplication[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MemberStoreError('申请数据损坏：文件不是合法 JSON');
  }

  const list = (parsed as { applications?: unknown } | null)?.applications;
  if (!Array.isArray(list)) {
    throw new MemberStoreError('申请数据损坏：缺少 applications 数组');
  }

  const apps: MemberApplication[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : '';
    const applicantSub = typeof record.applicantSub === 'string' ? record.applicantSub : '';
    if (!id || !applicantSub) continue;

    const text = (value: unknown, fallback = ''): string =>
      typeof value === 'string' ? value : fallback;
    const nullableText = (value: unknown): string | null =>
      typeof value === 'string' ? value : null;

    apps.push({
      id,
      applicantSub,
      applicantName: text(record.applicantName, applicantSub),
      userId: Number(record.userId) || 0,
      memberName: text(record.memberName),
      email: text(record.email),
      countryCode: text(record.countryCode, '86'),
      phone: text(record.phone),
      departmentPath: text(record.departmentPath),
      removingStartedAt: nullableText(record.removingStartedAt),
      deletedAt: nullableText(record.deletedAt),
      deleteRequestId: nullableText(record.deleteRequestId),
      deleteError: nullableText(record.deleteError),
      resolvedNodeId:
        typeof record.resolvedNodeId === 'number' ? record.resolvedNodeId : null,
      resolvedNodePath: nullableText(record.resolvedNodePath),
      remark: text(record.remark),
      status: text(record.status, 'pending') as MemberApplication['status'],
      uin: nullableText(record.uin),
      errorCode: nullableText(record.errorCode),
      errorMessage: nullableText(record.errorMessage),
      tencentRequestId: nullableText(record.tencentRequestId),
      reviewNote: nullableText(record.reviewNote),
      reviewedBy: nullableText(record.reviewedBy),
      reviewedAt: nullableText(record.reviewedAt),
      provisioningStartedAt: nullableText(record.provisioningStartedAt),
      lastAttemptAt: nullableText(record.lastAttemptAt),
      revision: typeof record.revision === 'number' && Number.isFinite(record.revision) ? record.revision : 0,
      events: Array.isArray(record.events) ? (record.events as MemberApplication['events']) : [],
      createdAt: text(record.createdAt, new Date().toISOString()),
      updatedAt: text(record.updatedAt, new Date().toISOString()),
    });
  }

  return apps;
}

const pgRepo: MemberApplicationRepo = {
  async read(): Promise<MemberApplication[]> {
    await ready();
    return selectAll(getDb());
  },

  async mutate<T>(fn: (apps: MemberApplication[]) => T | Promise<T>): Promise<T> {
    await ready();
    return withTransaction(async (tx) => {
      // 读全量 → 改 → 差分写回，必须串行：否则两个事务会各自基于旧快照覆盖对方，
      // 审核的 CAS（pending → provisioning）也会同时通过。advisory lock 跨实例生效。
      await tx.query('SELECT pg_advisory_xact_lock($1)', [MEMBER_STORE_LOCK_KEY]);
      const apps = await selectAll(tx);
      // 签名必须在回调修改对象之前取（fn 是原地改）
      const beforeSignatures = new Map(apps.map((app) => [app.id, signatureOf(app)]));
      const result = await fn(apps);
      await applyDiff(tx, apps, beforeSignatures);
      return result;
    });
  },
};

/** 测试用：把默认存储换成内存实现（传 null 恢复成数据库） */
let injectedRepo: MemberApplicationRepo | null = null;

export function setMemberApplicationRepo(repo: MemberApplicationRepo | null): void {
  injectedRepo = repo;
}

/** 测试用：忘掉「已迁移」状态 */
export function resetApplicationSeedCache(): void {
  seeding = null;
}

function repo(): MemberApplicationRepo {
  return injectedRepo ?? pgRepo;
}

/** 读全部申请单。 */
export async function readStore(repoArg?: MemberApplicationRepo): Promise<MemberApplication[]> {
  const apps = await (repoArg ?? repo()).read();
  return apps.map(normalize);
}

/**
 * 读 → 改 → 写，整段在同一个事务里完成。
 *
 * `mutator` 直接改传入的数组，返回值透传给调用方；写库前统一裁剪 `events`。
 */
export async function mutateStore<T>(
  mutator: (apps: MemberApplication[]) => T | Promise<T>,
  repoArg?: MemberApplicationRepo
): Promise<T> {
  return (repoArg ?? repo()).mutate((apps) => {
    trimEventsInPlace(apps);
    return mutator(apps);
  });
}

export function findBySub(
  apps: MemberApplication[],
  sub: string
): MemberApplication | undefined {
  return apps.find((app) => app.applicantSub === sub);
}

export function findById(
  apps: MemberApplication[],
  id: string
): MemberApplication | undefined {
  return apps.find((app) => app.id === id);
}

/** 管理员视角：待审核优先，其次按更新时间倒序。 */
export function sortForReview(apps: MemberApplication[]): MemberApplication[] {
  const weight = (status: MemberApplication['status']): number =>
    status === 'pending' ? 0 : status === 'provisioning' ? 1 : 2;

  return [...apps].sort((a, b) => {
    const byStatus = weight(a.status) - weight(b.status);
    if (byStatus !== 0) return byStatus;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
