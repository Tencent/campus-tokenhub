-- 021-own.sql（统一采买站）：只迁本侧业务表 → portal_assign.activity_configs
--
-- 与成员站的同名脚本结构相同、内容不同：各自迁自己的业务表。
-- 只读旧 `portal` schema，不修改任何旧数据。幂等（标记 migration.021.assign）。
--
--   psql "$PORTAL_DATABASE_URL" -f deploy/migrate/021-own.sql

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('portal_assign.activity_configs') IS NULL THEN
    RAISE EXCEPTION 'portal_assign 的表还没建：请先启动一次统一采买站，再执行本脚本';
  END IF;
END $$;

BEGIN;

SELECT NOT EXISTS (
  SELECT 1 FROM portal_shared.settings WHERE key = 'migration.021.assign'
) AS fresh \gset

\if :fresh

  INSERT INTO portal_assign.activity_configs (
    id, title, points, period, summary, badge, cta_label,
    starts_on, ends_on, weekdays, closed_hint,
    featured, enabled, sort_order, created_at, updated_at
  )
  SELECT
    id, title, points, period, summary, badge, cta_label,
    starts_on, ends_on, weekdays, closed_hint,
    featured, enabled, sort_order, created_at, updated_at
  FROM portal.activity_configs
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO portal_shared.settings (key, value)
  VALUES ('migration.021.assign', now()::text)
  ON CONFLICT (key) DO NOTHING;

  \echo '021-own（assign）迁移完成'
\else
  \echo '021-own（assign）已执行过，跳过'
\endif

COMMIT;

\echo '--- 迁移结果 ---'
SELECT (SELECT count(*) FROM portal_assign.activity_configs) AS new_cnt,
       (SELECT count(*) FROM portal.activity_configs) AS old_cnt;
