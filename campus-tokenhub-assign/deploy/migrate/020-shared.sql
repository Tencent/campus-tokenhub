-- 020-shared.sql：把旧 `portal` schema 的共享数据搬进 `portal_shared`。
--
-- 两侧仓库里的这份文件必须**逐字相同**（双站部署时谁先跑谁生效，另一个看到标记直接跳过）。
--
-- 设计约束（见 openspec/specs/portal-split.md）：
--   1. 幂等：执行成功写标记 `migration.020.shared`，重复执行直接返回；
--   2. **只读旧库**：全部是 SELECT，不 UPDATE / DELETE / DROP 旧 `portal` schema；
--   3. 加密字段默认**不迁**：tencent_*_enc / oauth2_client_secret_enc 落 NULL，
--      需要显式 `PGOPTIONS='-c campus_tokenhub.copy_secrets=1'` 才原样复制（要求两侧 SESSION_SECRET 相同）；
--   4. 旧库的模式字段（mode_assign_enabled / mode_member_enabled / mode_default）**不迁**：
--      拆仓后没有双模式概念，这些列在新表中保持 NULL。
--
-- 执行：
--   psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql
--   PGOPTIONS='-c campus_tokenhub.copy_secrets=1' psql "$PORTAL_DATABASE_URL" -f deploy/migrate/020-shared.sql
--
-- ⚠ 旧 schema 清理提醒：
--   迁移完成后可以手工 `DROP SCHEMA portal CASCADE` 清掉旧库（本地环境已于 2026-11-24 执行，
--   清理前备份位于 `.workbuddy/backup/portal-schema-*.sql`）。清理后**不要**再重跑本脚本：
--   `migration.020.shared` 标记会让它直接跳过，但标记一旦丢失（例如重建 settings 表），
--   本脚本会因 `SELECT ... FROM portal.*` 而中断。确需重跑时请先从备份恢复旧 schema。
--
--   同理，`portal_shared.app_config` 上的 local_admin_* 三列是历史遗留（真正生效的在
--   `login_config`，因为 `FIELDS.localAdminMode.section === 'login'`），已一并清理；
--   改引导期账号密码登录请改 `login_config`，改 `app_config` 不会有任何效果。

\set ON_ERROR_STOP on

DO $$
BEGIN
  IF to_regclass('portal_shared.app_config') IS NULL THEN
    RAISE EXCEPTION 'portal_shared 的表还没建：请先启动一次任一站点（应用会自动建表），再执行本脚本';
  END IF;
END $$;

BEGIN;

SELECT NOT EXISTS (
  SELECT 1 FROM portal_shared.settings WHERE key = 'migration.020.shared'
) AS fresh \gset

\if :fresh

  -- ---------------------------------------------------------------- 管理员名单
  INSERT INTO portal_shared.admins (sub, created_at)
  SELECT sub, created_at FROM portal.member_admins
  ON CONFLICT (sub) DO NOTHING;

  -- ---------------------------------------------------------------- 通用配置
  -- 目标表是单行表（singleton 主键）：先清空再写入，避免应用启动时先插了一行空记录导致跳过。
  DELETE FROM portal_shared.app_config;

  INSERT INTO portal_shared.app_config (
    singleton, school_name, login_title, login_subtitle, footer_contact, brand_color, logo,
    default_budget_max, default_budget_period, default_rate_limit_rpm, default_rate_limit_tpm,
    tencent_secret_id_enc, tencent_secret_key_enc, tencent_permission_ids,
    tencent_verify_status, tencent_verify_message, tencent_verified_at,
    currency_verify_status, currency_verify_message, currency_verified_at,
    updated_by, updated_at
  )
  SELECT
    true, school_name, login_title, login_subtitle, footer_contact, brand_color, logo,
    default_budget_max, default_budget_period, default_rate_limit_rpm, default_rate_limit_tpm,
    -- 密文默认不迁：换部署后 SESSION_SECRET 往往不同，带过去也解不开
    CASE WHEN current_setting('campus_tokenhub.copy_secrets', true) = '1'
         THEN tencent_secret_id_enc END,
    CASE WHEN current_setting('campus_tokenhub.copy_secrets', true) = '1'
         THEN tencent_secret_key_enc END,
    tencent_permission_ids,
    'unverified', NULL, NULL,   -- 换了部署，旧凭据验证结论一律作废（探针要重跑）
    'unverified', NULL, NULL,
    updated_by, updated_at
  FROM portal.app_config
  WHERE singleton;

  -- ---------------------------------------------------------------- 登录配置
  DELETE FROM portal_shared.login_config;

  INSERT INTO portal_shared.login_config (
    singleton, provider,
    oauth2_authorization_endpoint, oauth2_token_endpoint, oauth2_user_info_endpoint,
    oauth2_client_id, oauth2_client_secret_enc, oauth2_scopes,
    oauth2_token_auth_method, oauth2_user_info_token_carrier,
    oauth2_field_map_subject, oauth2_field_map_email, oauth2_field_map_name,
    oauth2_field_map_school_code, oauth2_field_map_school_name, oauth2_field_map_roles,
    cas_login_url, cas_ticket_validate_url,
    restrict_enabled, restrict_conditions,
    updated_by, updated_at
  )
  SELECT
    true, provider,
    oauth2_authorization_endpoint, oauth2_token_endpoint, oauth2_user_info_endpoint,
    oauth2_client_id,
    CASE WHEN current_setting('campus_tokenhub.copy_secrets', true) = '1'
         THEN oauth2_client_secret_enc END,
    oauth2_scopes, oauth2_token_auth_method, oauth2_user_info_token_carrier,
    oauth2_field_map_subject, oauth2_field_map_email, oauth2_field_map_name,
    oauth2_field_map_school_code, oauth2_field_map_school_name, oauth2_field_map_roles,
    cas_login_url, cas_ticket_validate_url,
    restrict_enabled, restrict_conditions,
    updated_by, updated_at
  FROM portal.login_config
  WHERE singleton;

  -- ---------------------------------------------------------------- 内部标记
  -- 旧的 config.structured.v1 之类标记一并带过来：新表若也识别它，说明配置已是结构化形态
  INSERT INTO portal_shared.settings (key, value, updated_at)
  SELECT key, value, updated_at FROM portal.settings
  ON CONFLICT (key) DO NOTHING;

  -- ---------------------------------------------------------------- 会话吊销
  -- 不迁的话，旧站登出过的设备会在新站重新「复活」
  INSERT INTO portal_shared.session_revocations (sub, revoked_before, updated_at)
  SELECT sub, revoked_before, updated_at FROM portal.session_revocations
  ON CONFLICT (sub) DO NOTHING;

  -- ---------------------------------------------------------------- 配置审计
  -- id 是自增：不指定，按新序列重新编号；只保留内容与时间
  INSERT INTO portal_shared.config_audit (key, action, value_hint, actor_sub, actor_ip, created_at)
  SELECT key, action, value_hint, actor_sub, actor_ip, created_at
  FROM portal.config_audit
  ORDER BY created_at;

  INSERT INTO portal_shared.settings (key, value)
  VALUES ('migration.020.shared', now()::text)
  ON CONFLICT (key) DO NOTHING;

  \echo '020-shared 迁移完成'

\else
  \echo '020-shared 已执行过（migration.020.shared 存在），跳过'
\endif

COMMIT;

-- ---------------------------------------------------------------- 迁移后对账
\echo '--- 迁移结果 ---'
SELECT 'admins' AS t, (SELECT count(*) FROM portal_shared.admins) AS new_cnt,
       (SELECT count(*) FROM portal.member_admins) AS old_cnt
UNION ALL SELECT 'app_config', (SELECT count(*) FROM portal_shared.app_config), (SELECT count(*) FROM portal.app_config)
UNION ALL SELECT 'login_config', (SELECT count(*) FROM portal_shared.login_config), (SELECT count(*) FROM portal.login_config)
UNION ALL SELECT 'config_audit', (SELECT count(*) FROM portal_shared.config_audit), (SELECT count(*) FROM portal.config_audit);

\echo '--- 加密列（默认应为空，需到设置页重新录入）---'
SELECT tencent_secret_id_enc IS NULL AS tencent_id_null,
       tencent_secret_key_enc IS NULL AS tencent_key_null
FROM portal_shared.app_config;
