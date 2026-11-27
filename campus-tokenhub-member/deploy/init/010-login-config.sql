-- 成员自购站首次部署的登录配置种子（与统一采买站共用 portal_shared.login_config）。
--
-- 由 docker compose 的一次性服务 `portal-seed` 在门户 healthy 之后执行，因此：
--   * 表一定已由门户启动时的 ensurePortalSchema 建好；万一没有，本脚本跳过而不是报错；
--   * 可以重复执行（每次 `docker compose up -d` 都会跑一遍）。
--
-- ============================================================================
--  ⚠ 必须用 psql 客户端执行：psql -v ON_ERROR_STOP=1 -f 010-login-config.sql
-- ============================================================================
-- 本文件不是纯 SQL：它用了 psql 专有的元命令与变量替换——
--   \set / \gset / \if / \else / \endif / \echo，以及 :'name' 形式的变量引用。
-- 这些**只有 psql 认**，换成 node-postgres、JDBC、DBeaver、pgAdmin 或任何通用
-- SQL 执行器都会在第一个 \set 处直接语法报错（而纯 SQL 客户端不会给出有用提示）。
-- 若必须用其它驱动执行，请改写本文件或改用「设置 → 登录认证」页面配置。
--
-- ============================================================================
--  学校对接参数：只改这一块，其余不用动
-- ============================================================================
-- 部署前把下面几项填成学校的实际值。留空 = 不写入，保持数据库原值
--（首次部署即视为「未对接」，用引导账号登录后在设置页补）。
--
-- 登录方式：oauth2 / cas / wecom（企业微信自建应用）
\set school_auth_provider 'oauth2'

-- ---- OAuth2（provider=oauth2 时生效）----
-- 三个地址由学校 IdP 提供；client_id 是应用编号
\set school_oauth2_authorization_endpoint ''
\set school_oauth2_token_endpoint ''
\set school_oauth2_user_info_endpoint ''
\set school_oauth2_client_id ''
-- 可选：留空则用标准默认值（client_secret_basic / header）
-- 学校 IdP 要求表单传参或 query 携带 token 时才填
\set school_oauth2_token_auth_method ''
\set school_oauth2_user_info_token_carrier ''

-- ---- CAS（provider=cas 时生效）----
-- 注意：CAS 的 service 参数是回调地址，必须在 CAS Server 白名单里登记该域名
\set school_cas_login_url ''
\set school_cas_ticket_validate_url ''

-- ---- 企业微信（provider=wecom 时生效）----
-- CorpID / AgentID 从企微管理后台「我的企业 / 应用详情页」获取；scope 留空则用默认值 snsapi_base
-- Secret 不写在这里：只能到「设置 → 登录认证」填一次，由门户进程加密落库。
\set school_wecom_corp_id ''
\set school_wecom_agent_id ''
\set school_wecom_scope ''

-- ============================================================================
--  以下为执行逻辑
-- ============================================================================
--
-- 三条硬约束：
--   1. 只填空值：所有列都用 COALESCE(col, 新值)，学校和运营在「设置 → 登录认证」里
--      改过的值一律保留，重复部署不会把配置改回种子值。
--   2. 不写 client_secret：密文由门户进程用 SESSION_SECRET（或 CONFIG_ENCRYPTION_KEY）
--      派生密钥加解密，SQL 里写不出可解密的密文。密钥只能在部署后到
--      「设置 → 登录认证」填一次（加密落库），不经过命令行、不进入本文件。
--   3. provider 只接受 oauth2 / cas / wecom，其它值按未配置处理，避免带着非法协议启动。

SELECT to_regclass('portal_shared.login_config') IS NOT NULL AS has_login_config \gset

\if :has_login_config

INSERT INTO portal_shared.login_config (singleton) VALUES (true)
  ON CONFLICT (singleton) DO NOTHING;

UPDATE portal_shared.login_config SET
  provider = COALESCE(provider,
    CASE WHEN :'school_auth_provider' IN ('oauth2', 'cas', 'wecom')
         THEN :'school_auth_provider' ELSE NULL END),

  oauth2_authorization_endpoint = COALESCE(oauth2_authorization_endpoint,
    NULLIF(:'school_oauth2_authorization_endpoint', '')),
  oauth2_token_endpoint = COALESCE(oauth2_token_endpoint,
    NULLIF(:'school_oauth2_token_endpoint', '')),
  oauth2_user_info_endpoint = COALESCE(oauth2_user_info_endpoint,
    NULLIF(:'school_oauth2_user_info_endpoint', '')),
  oauth2_client_id = COALESCE(oauth2_client_id,
    NULLIF(:'school_oauth2_client_id', '')),

  oauth2_token_auth_method = COALESCE(oauth2_token_auth_method,
    NULLIF(:'school_oauth2_token_auth_method', '')),
  oauth2_user_info_token_carrier = COALESCE(oauth2_user_info_token_carrier,
    NULLIF(:'school_oauth2_user_info_token_carrier', '')),

  cas_login_url = COALESCE(cas_login_url,
    NULLIF(:'school_cas_login_url', '')),
  cas_ticket_validate_url = COALESCE(cas_ticket_validate_url,
    NULLIF(:'school_cas_ticket_validate_url', '')),

  wecom_corp_id = COALESCE(wecom_corp_id,
    NULLIF(:'school_wecom_corp_id', '')),
  wecom_agent_id = COALESCE(wecom_agent_id,
    NULLIF(:'school_wecom_agent_id', '')),
  wecom_scope = COALESCE(wecom_scope,
    NULLIF(:'school_wecom_scope', '')),

  -- 只标记来源，不动 updated_at：避免每次部署都刷新「最近更新时间」的语义
  updated_by = COALESCE(updated_by, 'deploy-seed')
WHERE singleton;

\echo '[seed] 登录配置已写入（仅补空缺）：'
SELECT provider,
       COALESCE(oauth2_client_id, '(未配置)')              AS client_id,
       COALESCE(oauth2_authorization_endpoint, '(未配置)') AS authorization_endpoint,
       COALESCE(cas_login_url, '(未配置)')                 AS cas_login_url,
       CASE WHEN oauth2_client_secret_enc IS NULL
            THEN '未配置（需到设置页填一次）'
            ELSE '已加密落库' END                           AS client_secret
  FROM portal_shared.login_config WHERE singleton;

\else

\echo '[seed] portal_shared.login_config 尚未创建，跳过登录配置种子'

\endif

-- ============================================================================
--  参考：身份字段映射（可选，需要时取消注释）
-- ============================================================================
-- 标准 OAuth2 的 userinfo 返回 sub / name / email 就够了，不需要这段。
-- 只有 IdP 的字段名不标准（不叫 sub），或身份需要用 school_id:user_id 这类拼接才需要打开。
-- 留空的映射会走内置兼容字段识别，用标准 IdP 的学校不要打开。
--
-- UPDATE portal_shared.login_config SET
--   oauth2_token_auth_method        = COALESCE(oauth2_token_auth_method, 'client_secret_post'),
--   oauth2_user_info_token_carrier  = COALESCE(oauth2_user_info_token_carrier, 'query'),
--   oauth2_field_map_subject        = COALESCE(oauth2_field_map_subject, '{school_id}:{user_id}'),
--   oauth2_field_map_name           = COALESCE(oauth2_field_map_name, 'user_name'),
--   oauth2_field_map_school_code    = COALESCE(oauth2_field_map_school_code, 'school_id'),
--   oauth2_field_map_school_name    = COALESCE(oauth2_field_map_school_name, 'school_name'),
--   oauth2_field_map_roles          = COALESCE(oauth2_field_map_roles, 'role_name')
--   -- 命中这些角色的登录用户自动加入管理员名单（只增不删）：
--   admin_roles                     = COALESCE(admin_roles, ARRAY['school_admin'])
-- WHERE singleton;
