/**
 * 活动事件写入编排：登录事件、页面访问、180 天分批清理。
 *
 * 三条铁律：
 * 1. 任何失败只告警，绝不向调用方抛错——登录与页面不能因为埋点挂掉；
 * 2. 单次写入有超时预算（默认 300ms），超时即放弃，登录响应不等它；
 * 3. 站点由 `createActivityRecorder({ site })` 单点注入，调用方不再各自传字符串。
 *
 * 依赖通过 `db: () => Db` 惰性注入：门户允许不配数据库（本地纯前端调试），
 * 那种情况下 `db()` 抛错会被 run() 捕获并按「未配置」静默处理。
 */

import { normalizeVisitPath } from './path';
import { ACTIVITY_RETENTION_DAYS } from './schema';
import type { ActivitySite, LoginEventInput } from './types';

/** 最小查询接口：与门户 `src/lib/db/portal-db.ts` 的 `Db` 结构兼容 */
export type Db = {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
};

export type ActivityLogger = (message: string, meta?: Record<string, unknown>) => void;

export type ActivityRecorderOptions = {
  site: ActivitySite;
  /** 惰性取连接池：未配置数据库时应抛错，由 run() 静默 */
  db: () => Db;
  /** 时间源（毫秒），测试注入 */
  now?: () => number;
  /** 单次写入超时预算 */
  timeoutMs?: number;
  /** 清理最小间隔 */
  pruneIntervalMs?: number;
  /** 单批删除行数 */
  pruneBatchSize?: number;
  /** 单次清理最多执行几批 */
  pruneMaxBatches?: number;
  /** 相同错误的最小告警间隔 */
  logThrottleMs?: number;
  /**
   * 功能开关：门户设置页的「登录数据统计」，缺省关闭。
   * 返回 false 时所有写入与清理短路；不传视为开启（保持既有单测与调用方行为）。
   */
  isEnabled?: () => boolean | Promise<boolean>;
  logger?: ActivityLogger;
};

export type ActivityRecorder = {
  readonly site: ActivitySite;
  recordLogin(input: LoginEventInput): Promise<void>;
  recordPageView(sub: string, rawPath: unknown): Promise<void>;
  pruneIfDue(): Promise<void>;
};

export const DEFAULT_WRITE_TIMEOUT_MS = 300;
export const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
export const DEFAULT_PRUNE_BATCH_SIZE = 10_000;
export const DEFAULT_PRUNE_MAX_BATCHES = 5;
export const DEFAULT_LOG_THROTTLE_MS = 5 * 60 * 1000;

const PRUNE_TABLES = ['login_events', 'page_views'] as const;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给查询套一个超时：超时后 reject，底层查询仍在跑但不再阻塞调用方 */
function withTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`activity query timed out after ${ms}ms`));
    }, ms);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

export function createActivityRecorder(options: ActivityRecorderOptions): ActivityRecorder {
  const { site } = options;
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
  const pruneIntervalMs = options.pruneIntervalMs ?? DEFAULT_PRUNE_INTERVAL_MS;
  const pruneBatchSize = options.pruneBatchSize ?? DEFAULT_PRUNE_BATCH_SIZE;
  const pruneMaxBatches = options.pruneMaxBatches ?? DEFAULT_PRUNE_MAX_BATCHES;
  const logThrottleMs = options.logThrottleMs ?? DEFAULT_LOG_THROTTLE_MS;
  const logger = options.logger ?? ((message: string) => console.warn(message));

  const lastLoggedAt = new Map<string, number>();
  let lastPruneAt = 0;

  /**
   * 同一类错误在节流窗口内只记一次：PV 高峰时不能每行都打日志。
   *
   * 节流 key 取错误本身而非操作名——一次数据库故障会同时打穿 login_event、
   * page_view 与 prune，按操作名分桶会让同一故障重复告警。设计口径是
   * 「相同错误 5 分钟内只告警一次」，因此按错误描述分桶。
   */
  function warnThrottled(scope: string, error: unknown): void {
    const detail = describe(error);
    const at = now();
    const last = lastLoggedAt.get(detail);
    if (last !== undefined && at - last < logThrottleMs) return;
    lastLoggedAt.set(detail, at);
    logger(`[portal-activity] ${scope} 失败：${detail}`);
  }

  /**
   * 读取功能开关。读配置本身失败时按「关闭」处理：
   * 统计缺失优于把配置层的错误带进登录流程。
   */
  async function enabled(): Promise<boolean> {
    if (!options.isEnabled) return true;
    try {
      return await options.isEnabled();
    } catch {
      return false;
    }
  }

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    try {
      await task();
    } catch (error) {
      warnThrottled(key, error);
    }
  }

  async function pruneIfDue(): Promise<void> {
    if (!(await enabled())) return;

    const at = now();
    if (lastPruneAt !== 0 && at - lastPruneAt < pruneIntervalMs) return;
    // 先占位再执行：并发请求同时到达时只有一个真正去删
    lastPruneAt = at;

    await run('prune', async () => {
      const db = options.db();
      for (const table of PRUNE_TABLES) {
        for (let batch = 0; batch < pruneMaxBatches; batch += 1) {
          const result = await db.query<{ id: string }>(
            `DELETE FROM portal_shared.${table}
              WHERE id IN (
                SELECT id FROM portal_shared.${table}
                 WHERE occurred_at < now() - make_interval(days => $1)
                 LIMIT $2
              )
              RETURNING id`,
            [ACTIVITY_RETENTION_DAYS, pruneBatchSize]
          );
          if (result.rows.length < pruneBatchSize) break;
        }
      }
    });
  }

  async function recordLogin(input: LoginEventInput): Promise<void> {
    if (!input.sub) return;
    if (!(await enabled())) return;

    await run('login_event', async () => {
      const db = options.db();
      await withTimeout(
        db.query(
          `INSERT INTO portal_shared.login_events (site, sub, name, email, login_method)
           VALUES ($1, $2, $3, $4, $5)`,
          [site, input.sub, input.name ?? null, input.email ?? null, input.method]
        ),
        timeoutMs
      );
    });

    // 清理不阻塞登录响应：内部已 try/catch，不会产生 unhandled rejection
    void pruneIfDue();
  }

  async function recordPageView(sub: string, rawPath: unknown): Promise<void> {
    if (!sub) return;
    if (!(await enabled())) return;
    const path = normalizeVisitPath(rawPath);
    if (!path) return;

    await run('page_view', async () => {
      const db = options.db();
      await withTimeout(
        db.query(`INSERT INTO portal_shared.page_views (site, sub, path) VALUES ($1, $2, $3)`, [
          site,
          sub,
          path,
        ]),
        timeoutMs
      );
    });

    void pruneIfDue();
  }

  return { site, recordLogin, recordPageView, pruneIfDue };
}
