/**
 * 运营活动配置的持久化：门户自己的 `portal_assign.activity_configs` 表（一行一个活动）。
 *
 * 背景：早期版本把整份活动列表塞进网关 `system_config` 的 `ACTIVITY_CONFIG` 键，
 * 一份 JSON 字符串既不好查也不好改。现在改为独立表，并通过网关 Admin API
 * 做**一次性迁移**：表还是空的且没有迁移标记时，读旧的 `system_config` 导入，
 * 导入完写 `portal.settings` 标记，之后只认表。
 *
 * 表为空且没有标记（例如数据库刚建、网关也读不到）时，读接口回退仓库里的
 * `ACTIVITY_CONFIG` 默认配置，保证学生端至少能看到活动卡。
 */

import { getGatewayClient } from '@/lib/gateway/client';
import { readSystemConfig } from '@/lib/onboarding/gateway-state';
import { getDb, withTransaction, type Db } from '@/lib/db/portal-db';
import { ensurePortalSchema, readSetting, writeSetting } from '@/lib/db/portal-schema';
import { ACTIVITY_CONFIG } from './config';
import type { ClaimPeriod, TokenActivityConfig } from './types';

/** 迁移用：旧配置在网关 `system_config` 里的键名 */
export const ACTIVITY_CONFIG_KEY = 'ACTIVITY_CONFIG';
/** 迁移完成标记（`portal.settings`），不是业务数据 */
const ACTIVITY_SEEDED_KEY = 'activity_config_initialized';

/** 一次最多配置多少个活动：卡片一屏放得下，也避免误操作塞爆 */
export const MAX_ACTIVITIES = 10;

/** 活动 ID 会进加额幂等键，只允许小写字母 / 数字 / 短横线 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const CLAIM_PERIODS: readonly ClaimPeriod[] = ['once', 'daily', 'weekly', 'monthly'];

/** 配置校验失败：消息是给管理员看的，直接透到页面提示 */
export class ActivityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActivityConfigError';
  }
}

export type ActivityConfigState = {
  activities: TokenActivityConfig[];
  /** true = 表里已经有一份配置（含管理员主动清空）；false = 还没接管，展示的是仓库默认值 */
  managed: boolean;
  /** true = 读数据库失败，展示的是仓库默认值 */
  degraded: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ActivityConfigError('活动配置项格式不正确');
  }
  return value as Record<string, unknown>;
}

/** 可选文本：空白折叠成 undefined，超长直接报错 */
function readOptionalText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ActivityConfigError(`${label}应为文本`);
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) throw new ActivityConfigError(`${label}最多 ${max} 个字符`);
  return text;
}

/** YYYY-MM-DD；不合法（含 2026-02-31 这类）时抛错 */
function readDay(value: unknown, label: string): string | undefined {
  const text = readOptionalText(value, label, 10);
  if (!text) return undefined;
  if (!DAY_PATTERN.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new ActivityConfigError(`${label}应为 YYYY-MM-DD`);
  }
  return text;
}

function readSummary(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ActivityConfigError('活动说明应为文本列表');

  const lines: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new ActivityConfigError('活动说明应为文本列表');
    const line = item.trim();
    if (!line) continue;
    if (line.length > 60) throw new ActivityConfigError('每条活动说明最多 60 个字符');
    lines.push(line);
  }
  if (lines.length > 6) throw new ActivityConfigError('活动说明最多 6 行');
  return lines;
}

function readWeekdays(value: unknown): number[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Array.isArray(value)) throw new ActivityConfigError('可领取星期应为 0-6 的数组');

  const days = value.map((item) => {
    const day = Number(item);
    if (!Number.isInteger(day) || day < 0 || day > 6) {
      throw new ActivityConfigError('可领取星期应为 0-6 的数组');
    }
    return day;
  });
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : undefined;
}

/** 单个活动：校验 + 归一化（去掉未知字段、裁剪空白） */
export function normalizeActivity(value: unknown): TokenActivityConfig {
  const record = asRecord(value);

  const id = readOptionalText(record.id, '活动 ID', 48);
  if (!id || !ID_PATTERN.test(id)) {
    throw new ActivityConfigError('活动 ID 需为 2-48 位小写字母、数字或短横线，且以字母或数字开头');
  }

  const title = readOptionalText(record.title, '活动名称', 40);
  if (!title) throw new ActivityConfigError(`活动「${id}」缺少名称`);

  const points = Number(record.points);
  if (!Number.isInteger(points) || points < 1 || points > 10_000_000) {
    throw new ActivityConfigError(`「${title}」的算力值需为 1-10000000 的整数`);
  }

  const period = String(record.period ?? '').trim() as ClaimPeriod;
  if (!CLAIM_PERIODS.includes(period)) {
    throw new ActivityConfigError(`「${title}」的领取频次不合法`);
  }

  const startsOn = readDay(record.startsOn, '开始日期');
  const endsOn = readDay(record.endsOn, '结束日期');
  if (startsOn && endsOn && startsOn > endsOn) {
    throw new ActivityConfigError(`「${title}」的结束日期不能早于开始日期`);
  }

  const activity: TokenActivityConfig = { id, title, points, period, summary: readSummary(record.summary) };

  const badge = readOptionalText(record.badge, '角标', 12);
  if (badge) activity.badge = badge;

  const ctaLabel = readOptionalText(record.ctaLabel, '按钮文案', 12);
  if (ctaLabel) activity.ctaLabel = ctaLabel;

  const closedHint = readOptionalText(record.closedHint, '不可领取提示', 40);
  if (closedHint) activity.closedHint = closedHint;

  if (startsOn) activity.startsOn = startsOn;
  if (endsOn) activity.endsOn = endsOn;

  const weekdays = readWeekdays(record.weekdays);
  if (weekdays) activity.weekdays = weekdays;

  if (typeof record.featured === 'boolean') activity.featured = record.featured;
  // 缺省视为上架：老配置里没写 enabled 的活动不能被"保存一次"弄成下架
  if (typeof record.enabled === 'boolean') activity.enabled = record.enabled;

  return activity;
}

/** 活动列表：逐项校验 + ID 去重 + 数量上限 */
export function normalizeActivityList(value: unknown): TokenActivityConfig[] {
  if (!Array.isArray(value)) throw new ActivityConfigError('活动配置应为数组');
  if (value.length > MAX_ACTIVITIES) throw new ActivityConfigError(`最多配置 ${MAX_ACTIVITIES} 个活动`);

  const activities = value.map((item) => normalizeActivity(item));

  const seen = new Set<string>();
  for (const activity of activities) {
    if (seen.has(activity.id)) throw new ActivityConfigError(`活动 ID「${activity.id}」重复`);
    seen.add(activity.id);
  }

  return activities;
}

/** 旧配置（system_config 里的 JSON 串）→ 活动列表；格式不对按配置非法处理 */
export function parseActivityConfig(raw: string): TokenActivityConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ActivityConfigError('活动配置不是合法 JSON');
  }
  return normalizeActivityList(parsed);
}

/** 表里的一行 → 配置对象（只带非空字段，保持与旧 JSON 结构一致） */
type ActivityRow = {
  id: string;
  title: string;
  points: number;
  period: string;
  summary: string[] | null;
  badge: string | null;
  cta_label: string | null;
  starts_on: string | null;
  ends_on: string | null;
  weekdays: number[] | null;
  closed_hint: string | null;
  featured: boolean;
  enabled: boolean;
};

function rowToActivity(row: ActivityRow): TokenActivityConfig {
  const activity: TokenActivityConfig = {
    id: row.id,
    title: row.title,
    points: row.points,
    period: row.period as ClaimPeriod,
    summary: Array.isArray(row.summary) ? row.summary.map((line) => String(line)) : [],
  };
  if (row.badge) activity.badge = row.badge;
  if (row.cta_label) activity.ctaLabel = row.cta_label;
  if (row.closed_hint) activity.closedHint = row.closed_hint;
  if (row.starts_on) activity.startsOn = row.starts_on;
  if (row.ends_on) activity.endsOn = row.ends_on;
  if (Array.isArray(row.weekdays) && row.weekdays.length > 0) {
    activity.weekdays = row.weekdays.map((day) => Number(day));
  }
  if (row.featured) activity.featured = true;
  if (!row.enabled) activity.enabled = false;
  return activity;
}

const INSERT_ACTIVITY = `
  INSERT INTO portal_assign.activity_configs (
    id, title, points, period, summary, badge, cta_label,
    starts_on, ends_on, weekdays, closed_hint, featured, enabled, sort_order
  ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::smallint[], $11, $12, $13, $14)`;

const INSERT_ACTIVITY_IGNORE = `${INSERT_ACTIVITY} ON CONFLICT (id) DO NOTHING`;

function insertParams(activity: TokenActivityConfig, sortOrder: number): unknown[] {
  return [
    activity.id,
    activity.title,
    activity.points,
    activity.period,
    JSON.stringify(activity.summary),
    activity.badge ?? null,
    activity.ctaLabel ?? null,
    activity.startsOn ?? null,
    activity.endsOn ?? null,
    activity.weekdays ?? null,
    activity.closedHint ?? null,
    activity.featured === true,
    activity.enabled !== false,
    sortOrder,
  ];
}

/** 存储实现：生产用 pg，测试可以换成内存实现 */
export type ActivityConfigRepo = {
  isInitialized(): Promise<boolean>;
  list(): Promise<TokenActivityConfig[]>;
  replaceAll(activities: TokenActivityConfig[]): Promise<void>;
};

async function readyDb(): Promise<Db> {
  await ensurePortalSchema();
  await seedFromLegacyOnce();
  return getDb();
}

/**
 * 一次性迁移：表里没有数据且没有标记时，把旧 `system_config` 的配置导进来。
 *
 * 网关读不到就先不迁移（不写标记），下次进程启动再试——这期间读接口走默认配置兜底。
 */
let seeding: Promise<void> | null = null;

function seedFromLegacyOnce(): Promise<void> {
  if (!seeding) {
    seeding = seedFromLegacy().catch((error: unknown) => {
      seeding = null;
      throw error;
    });
  }
  return seeding;
}

async function seedFromLegacy(): Promise<void> {
  const db = getDb();
  if (await readSetting(db, ACTIVITY_SEEDED_KEY)) return;

  let imported: TokenActivityConfig[];
  try {
    const config = await readSystemConfig(getGatewayClient());
    const raw = config.get(ACTIVITY_CONFIG_KEY);
    if (raw === undefined) {
      imported = ACTIVITY_CONFIG;
    } else {
      try {
        imported = parseActivityConfig(raw);
      } catch {
        // 旧值是坏数据：不阻塞迁移，直接用仓库默认配置
        imported = ACTIVITY_CONFIG;
      }
    }
  } catch {
    // 网关读不到：保持「未初始化」，下次再试
    return;
  }

  await withTransaction(async (tx) => {
    if (await readSetting(tx, ACTIVITY_SEEDED_KEY)) return;
    const { rows } = await tx.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM portal_assign.activity_configs'
    );
    if ((rows[0]?.count ?? 0) === 0) {
      for (const [index, activity] of imported.entries()) {
        await tx.query(INSERT_ACTIVITY_IGNORE, insertParams(activity, index));
      }
    }
    await writeSetting(tx, ACTIVITY_SEEDED_KEY, new Date().toISOString());
  });
}

const pgRepo: ActivityConfigRepo = {
  async isInitialized(): Promise<boolean> {
    const db = await readyDb();
    return Boolean(await readSetting(db, ACTIVITY_SEEDED_KEY));
  },

  async list(): Promise<TokenActivityConfig[]> {
    const db = await readyDb();
    const { rows } = await db.query<ActivityRow>(
      `SELECT id, title, points, period, summary, badge, cta_label,
              starts_on, ends_on, weekdays, closed_hint, featured, enabled
         FROM portal_assign.activity_configs
        ORDER BY sort_order, created_at, id`
    );
    return rows.map(rowToActivity);
  },

  async replaceAll(activities: TokenActivityConfig[]): Promise<void> {
    await readyDb();
    await withTransaction(async (tx) => {
      await tx.query('DELETE FROM portal_assign.activity_configs');
      for (const [index, activity] of activities.entries()) {
        // 覆盖写：先删后插，等价于整份替换；ID 仍按主键约束保证唯一
        await tx.query(INSERT_ACTIVITY, insertParams(activity, index));
      }
      await writeSetting(tx, ACTIVITY_SEEDED_KEY, new Date().toISOString());
    });
  },
};

/**
 * 读当前生效的活动配置。
 *
 * 数据库异常不抛：活动区只是「我的算力」页的一块内容，读失败把整页打崩不值得。
 * 调用方需要知道是否降级时看 `degraded`。
 */
export async function readActivityConfig(
  repo: ActivityConfigRepo = pgRepo
): Promise<ActivityConfigState> {
  try {
    const activities = await repo.list();
    if (activities.length > 0) return { activities, managed: true, degraded: false };

    // 空表：区分「管理员主动清空」与「还没接管」
    const initialized = await repo.isInitialized();
    if (initialized) return { activities: [], managed: true, degraded: false };
    return { activities: ACTIVITY_CONFIG, managed: false, degraded: false };
  } catch {
    return { activities: ACTIVITY_CONFIG, managed: false, degraded: true };
  }
}

/** 覆盖写整份配置；返回归一化后的结果。 */
export async function writeActivityConfig(
  activities: unknown,
  repo: ActivityConfigRepo = pgRepo
): Promise<TokenActivityConfig[]> {
  const normalized = normalizeActivityList(activities);
  await repo.replaceAll(normalized);
  return normalized;
}

/** 测试用：忘掉「已迁移」状态 */
export function resetActivitySeedCache(): void {
  seeding = null;
}
