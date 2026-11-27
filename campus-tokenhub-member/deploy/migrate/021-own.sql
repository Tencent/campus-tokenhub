-- 021-own.sql（成员自购站）：只迁本侧业务表 → portal_member.member_applications
--
-- 与统一采买站的同名脚本结构相同、内容不同。
-- 只读旧 `portal` schema，不修改任何旧数据。幂等（标记 migration.021.member）。
--
--   psql "$PORTAL_DATABASE_URL" -f deploy/migrate/021-own.sql

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('portal_member.member_applications') IS NULL THEN
    RAISE EXCEPTION 'portal_member 的表还没建：请先启动一次成员自购站，再执行本脚本';
  END IF;
END $$;

BEGIN;

SELECT NOT EXISTS (
  SELECT 1 FROM portal_shared.settings WHERE key = 'migration.021.member'
) AS fresh \gset

\if :fresh

  INSERT INTO portal_member.member_applications (
    id, applicant_sub, applicant_name, user_id, member_name, email, country_code, phone,
    department_path, resolved_node_id, resolved_node_path, remark, status, uin,
    error_code, error_message, tencent_request_id, review_note, reviewed_by, reviewed_at,
    provisioning_started_at, last_attempt_at, revision, events, created_at, updated_at
  )
  SELECT
    id, applicant_sub, applicant_name, user_id, member_name, email, country_code, phone,
    department_path, resolved_node_id, resolved_node_path, remark, status, uin,
    error_code, error_message, tencent_request_id, review_note, reviewed_by, reviewed_at,
    provisioning_started_at, last_attempt_at, revision, events, created_at, updated_at
  FROM portal.member_applications
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO portal_shared.settings (key, value)
  VALUES ('migration.021.member', now()::text)
  ON CONFLICT (key) DO NOTHING;

  \echo '021-own（member）迁移完成'
\else
  \echo '021-own（member）已执行过，跳过'
\endif

COMMIT;

\echo '--- 迁移结果 ---'
SELECT (SELECT count(*) FROM portal_member.member_applications) AS new_cnt,
       (SELECT count(*) FROM portal.member_applications) AS old_cnt;
