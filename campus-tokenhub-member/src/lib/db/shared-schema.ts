/**
 * 共享层 DDL（`portal_shared`）：管理员名单、配置、审计、会话吊销、内部标记。
 *
 * ⚠️ **两个仓库里的这份文件必须逐字相同**（`campus-tokenhub-assign` 与 `campus-tokenhub-member`）。
 * 两站共用同一个 `portal_shared` schema，任何一处改动都要同步另一处，否则谁先启动谁的 DDL 生效，
 * 会出现「一侧能写、另一侧读不到」的诡异现象。用 `npm run check:shared-ddl` 校验两侧一致。
 *
 * 本侧专属的业务表不在共享层——统一采买站是运营活动，成员站是账号申请单，
 * 各自写在 `portal-schema.ts` 里，用各自 schema 下的表名。
 */

import { ACTIVITY_SCHEMA_STATEMENTS } from '@campus/portal-activity';
import { APP_CONFIG_TABLE, LOGIN_CONFIG_TABLE, SHARED_SCHEMA } from '@/lib/config/tables';

export const SHARED_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE SCHEMA IF NOT EXISTS ${SHARED_SCHEMA}`,
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.admins (
     sub        text PRIMARY KEY,
     role       text NOT NULL DEFAULT 'portal_admin',
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  `ALTER TABLE ${SHARED_SCHEMA}.admins ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT \'portal_admin\'`,
  // role 是历史列：早期按「审核管理员 / 门户管理员」分权，现在名单里的人一律是全局管理员
  // （代码不再读它）。这里把默认值与历史行都归并成 portal_admin，免得库里的数据与页面文案打架。
  `ALTER TABLE ${SHARED_SCHEMA}.admins ALTER COLUMN role SET DEFAULT \'portal_admin\'`,
  `UPDATE ${SHARED_SCHEMA}.admins SET role = 'portal_admin' WHERE role <> 'portal_admin'`,
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.settings (
     key        text PRIMARY KEY,
     value      text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
  // 会话吊销：无状态 JWT 记不下「已登出」，这里按用户存一个时间点，
  // 签发时间早于该点的会话一律失效（登出即吊销该用户所有设备上的会话）。
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.session_revocations (
     sub            text PRIMARY KEY,
     revoked_before timestamptz NOT NULL,
     updated_at     timestamptz NOT NULL DEFAULT now()
   )`,
  // 运行期配置：单行结构化表，一个字段一列；NULL 表示未配置（读取时回落到有效默认值）。
  // 密钥只写 *_enc（AES-256-GCM 密文），数组用 Postgres 原生数组类型。
  `CREATE TABLE IF NOT EXISTS ${APP_CONFIG_TABLE} (
     singleton              boolean PRIMARY KEY DEFAULT true CHECK (singleton),
     school_name            text,
     login_title            text,
     login_subtitle         text,
     footer_contact         text,
     brand_color            text,
     logo                   text,
     default_budget_max     integer,
     default_budget_period  text,
     default_rate_limit_rpm integer,
     default_rate_limit_tpm integer,
     -- 登录数据统计总开关：NULL = 关闭（缺省关闭）
     activity_enabled       boolean,
     mode_assign_enabled    boolean,
     mode_member_enabled    boolean,
     mode_default           text,
     tencent_secret_id_enc  bytea,
     tencent_secret_key_enc bytea,
     tencent_permission_ids integer[],
     tencent_verify_status  text NOT NULL DEFAULT 'unverified',
     tencent_verify_message text,
     tencent_verified_at    timestamptz,
     currency_verify_status  text NOT NULL DEFAULT 'unverified',
     currency_verify_message text,
     currency_verified_at    timestamptz,
     updated_by  text,
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
  // 登录认证配置单独一张单行结构化表：敏感度、备份口径与排查入口都能单独处理。
  `CREATE TABLE IF NOT EXISTS ${LOGIN_CONFIG_TABLE} (
     singleton                       boolean PRIMARY KEY DEFAULT true CHECK (singleton),
     provider                        text,
     oauth2_authorization_endpoint   text,
     oauth2_token_endpoint           text,
     oauth2_user_info_endpoint       text,
     oauth2_client_id                text,
     oauth2_client_secret_enc        bytea,
     oauth2_scopes                   text,
     oauth2_token_auth_method        text,
     oauth2_user_info_token_carrier  text,
     oauth2_field_map_subject        text,
     oauth2_field_map_email          text,
     oauth2_field_map_name           text,
     oauth2_field_map_school_code    text,
     oauth2_field_map_school_name    text,
     oauth2_field_map_roles          text,
     admin_roles                     text[],
     cas_login_url                   text,
     cas_ticket_validate_url         text,
     restrict_enabled                boolean,
     restrict_conditions             jsonb,
     updated_by  text,
     updated_at  timestamptz NOT NULL DEFAULT now(),
     local_admin_mode                text,
     local_admin_username            text,
     local_admin_password_enc        bytea,
     wecom_corp_id                   text,
     wecom_agent_id                  text,
     wecom_client_secret_enc         bytea,
     wecom_scope                     text
   )`,
  // 默认限流（开户时写入网关 users.rate_limit；NULL = 不限）
  // 给「表已存在但缺这两列」的老库补列；新建表已在 DDL 里带这两列，这里是空操作
  //
  // ⚠ 顺序要求：这些 ALTER 必须排在 app_config / login_config 的 CREATE TABLE **之后**。
  // `ADD COLUMN IF NOT EXISTS` 只对列判存，表本身不存在时整条语句会报错；
  // 一旦排在建表之前，全新库（没有任何 portal_shared 表）会在事务里失败并整体回滚，
  // 表现是「门户起来了但读不到配置：relation portal_shared.app_config does not exist」。
  `ALTER TABLE ${APP_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS default_rate_limit_rpm integer`,
  `ALTER TABLE ${APP_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS default_rate_limit_tpm integer`,
  // 登录数据统计总开关：缺省 NULL（= 关闭）。关闭后两站不采集、网关不出接口、菜单不展示。
  `ALTER TABLE ${APP_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS activity_enabled boolean`,
  // 部署管理员（引导期账号密码登录）从「只能环境变量」改为「可界面配置」。
  // 归属 login 分区，所以加在 login_config 上，不是 app_config。
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS local_admin_mode text`,
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS local_admin_username text`,
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS local_admin_password_enc bytea`,
  // 角色自动同步管理员：登录用户角色命中配置值时加入管理员名单（只增不删）
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS admin_roles text[]`,
  // 企业微信（自建应用）登录：Secret 只存 AES-GCM 密文；scope 默认 snsapi_base 由代码层提供，
  // 列留空表示未配置，便于部署种子按「只补空值」写入。
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS wecom_corp_id text`,
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS wecom_agent_id text`,
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS wecom_client_secret_enc bytea`,
  `ALTER TABLE ${LOGIN_CONFIG_TABLE} ADD COLUMN IF NOT EXISTS wecom_scope text`,
  // 配置变更审计：只存键名、动作与脱敏提示，永不存明文/密文
  `CREATE TABLE IF NOT EXISTS ${SHARED_SCHEMA}.config_audit (
     id         bigserial PRIMARY KEY,
     key        text NOT NULL,
     action     text NOT NULL,
     value_hint text,
     actor_sub  text,
     actor_ip   text,
     created_at timestamptz NOT NULL DEFAULT now()
   )`,
  // 登录事件与页面访问表：由共享包 `packages/portal-activity` 单一维护，
  // 两站展开同一份语句，避免手写两份 DDL 时漏改一侧。
  ...ACTIVITY_SCHEMA_STATEMENTS,
];
