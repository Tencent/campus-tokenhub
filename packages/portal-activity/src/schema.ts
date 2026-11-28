/**
 * 新增两张共享表的 DDL。
 *
 * 两站的 `src/lib/db/shared-schema.ts` 直接展开本常量，因此这两张表
 * 只有一份定义；老表仍由两站各自复制，靠 `npm run check:shared-ddl` 校验。
 *
 * 语句必须以 CREATE / ALTER / UPDATE / DELETE 开头（两侧共享层测试的既有断言）。
 */

const SHARED_SCHEMA = 'portal_shared';

/** 留存天数，写进清理语句与文档口径 */
export const ACTIVITY_RETENTION_DAYS = 180;

export const ACTIVITY_SCHEMA_STATEMENTS: readonly string[] = [
  // 登录成功事件：一行一次登录。不存 IP/UA，避免把个人信息带进分析库。
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.login_events (
     id            bigserial PRIMARY KEY,
     occurred_at   timestamptz NOT NULL DEFAULT now(),
     site          text NOT NULL CHECK (site IN ('assign', 'member')),
     sub           text NOT NULL,
     name          text,
     email         text,
     login_method  text
   )`,
  // 页面访问事件：只存 pathname，不存 query。
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.page_views (
     id          bigserial PRIMARY KEY,
     occurred_at timestamptz NOT NULL DEFAULT now(),
     site        text NOT NULL CHECK (site IN ('assign', 'member')),
     sub         text NOT NULL,
     path        text NOT NULL
   )`,
  // 时间窗过滤（看板区间、清理）
  `CREATE INDEX IF NOT EXISTS login_events_occurred_at_idx ON ${SHARED_SCHEMA}.login_events (occurred_at)`,
  `CREATE INDEX IF NOT EXISTS page_views_occurred_at_idx ON ${SHARED_SCHEMA}.page_views (occurred_at)`,
  // 按用户回查最近一条登录（排行里的姓名/邮箱，逐用户 index scan backward）。
  // 只有 login_events 需要：page_views 没有任何按 sub 的查询，见下方废弃索引清单。
  `CREATE INDEX IF NOT EXISTS login_events_sub_occurred_at_idx ON ${SHARED_SCHEMA}.login_events (sub, occurred_at)`,
  // 按站点筛选（看板的站点维度）
  `CREATE INDEX IF NOT EXISTS login_events_site_occurred_at_idx ON ${SHARED_SCHEMA}.login_events (site, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS page_views_site_occurred_at_idx ON ${SHARED_SCHEMA}.page_views (site, occurred_at)`,
];

/**
 * 已废弃的索引：门户启动时清理一次。
 *
 * `page_views (sub, occurred_at)` 建了但从未被使用——排行按 `sub` 聚合走的是
 * `occurred_at`，姓名/邮箱回查只查 `login_events`。`pg_stat_user_indexes` 实测
 * `idx_scan = 0`，而它要在每次 PV 写入时维护（PV 是最高频写入），200 万行时约 100MB。
 *
 * 单独成一个常量而不是混进 `ACTIVITY_SCHEMA_STATEMENTS`：
 * 后者被两侧共享层测试断言「每条语句都以 CREATE 开头」，DROP 不属于建表语句。
 */
export const ACTIVITY_OBSOLETE_INDEX_STATEMENTS: readonly string[] = [
  `DROP INDEX IF EXISTS ${SHARED_SCHEMA}.page_views_sub_occurred_at_idx`,
];
