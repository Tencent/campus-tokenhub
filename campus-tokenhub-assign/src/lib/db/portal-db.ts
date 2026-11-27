/**
 * 门户自有的数据库连接（只用于 `portal` schema 里的表）。
 *
 * 为什么门户开始直连数据库：
 * - 运营活动、全局管理员名单原来放在网关 `system_config` 的键值里，一份数据挤成
 *   JSON / 逗号串，既不好查也不好改；改成两张独立表后可以直接 SQL 维护。
 * - 门户仍然**不碰**网关的业务表（`octafuse_gateway.*`），只在同一个库的 `portal`
 *   schema 里建自己的表，和网关的数据靠 schema 隔离。
 *
 * 连接串优先读 `PORTAL_DATABASE_URL`，没配时退回 `DATABASE_URL`（compose 里两处同值）。
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

/** 只暴露查询能力的最小接口：存储层用它，测试可以塞一个内存实现 */
export type Db = {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<{ rows: R[] }>;
};

export class DbNotConfiguredError extends Error {
  constructor() {
    super('门户数据库未配置：请设置 PORTAL_DATABASE_URL');
    this.name = 'DbNotConfiguredError';
  }
}

function connectionString(): string {
  return (process.env.PORTAL_DATABASE_URL ?? process.env.DATABASE_URL ?? '').trim();
}

let pool: Pool | null = null;

export function isPortalDbConfigured(): boolean {
  return connectionString().length > 0;
}

/**
 * 进程内单例连接池。
 *
 * `max` 取 5：门户的并发来自页面/接口，单实例 5 条连接足够，也不会把网关的
 * Postgres 连接数吃满（网关自己也连同一个库）。
 */
export function getDb(): Pool {
  if (!isPortalDbConfigured()) throw new DbNotConfiguredError();
  if (!pool) {
    pool = new Pool({
      connectionString: connectionString(),
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // 空闲连接被数据库踢掉时 pg 会在这里抛，不监听会让进程直接崩
    pool.on('error', (error) => {
      console.error('[portal-db] 空闲连接异常', error.message);
    });
  }
  return pool;
}

/** 事务：回调里拿到的是同一个 client，异常自动回滚并释放。 */
export async function withTransaction<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client: PoolClient = await getDb().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 测试/热重载用：关掉连接池，下次调用重新建。 */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  const closing = pool;
  pool = null;
  await closing.end().catch(() => undefined);
}

export type { QueryResult };
