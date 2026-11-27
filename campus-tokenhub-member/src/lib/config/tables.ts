/**
 * 表名与 schema 的唯一声明处。
 *
 * 数据分三层（见 openspec design D4）：
 * - `portal_shared`：两侧共用，只有一份数据（管理员、登录配置、品牌、会话吊销、标记、审计）
 * - `portal_member`：本侧业务表
 *
 * **共享层的 DDL 与表名两侧必须逐字相同**：两侧启动都会跑 `ensurePortalSchema()`，
 * `CREATE TABLE IF NOT EXISTS` 不补列，任一侧少一列都会让另一侧的读写失败。
 * 用 `npm run check:shared-ddl` 校验。
 */

export const SHARED_SCHEMA = 'portal_shared';
export const OWN_SCHEMA = 'portal_member';

export function sharedSchema(): string {
  return SHARED_SCHEMA;
}

export function ownSchema(): string {
  return OWN_SCHEMA;
}

export function sharedTable(name: string): string {
  return `${SHARED_SCHEMA}.${name}`;
}

export function ownTable(name: string): string {
  return `${OWN_SCHEMA}.${name}`;
}

/** 共享层六张表 */
export const ADMINS_TABLE = sharedTable('admins');
export const APP_CONFIG_TABLE = sharedTable('app_config');
export const LOGIN_CONFIG_TABLE = sharedTable('login_config');
export const SETTINGS_TABLE = sharedTable('settings');
export const SESSION_REVOCATIONS_TABLE = sharedTable('session_revocations');
export const CONFIG_AUDIT_TABLE = sharedTable('config_audit');

/** 结构化迁移期间的临时表名（迁移完成后在同事务内 DROP） */
export const LEGACY_APP_CONFIG_TABLE = sharedTable('app_config_eav_legacy');
export const LEGACY_LOGIN_CONFIG_TABLE = sharedTable('login_config_eav_legacy');

/** 本侧业务表 */
export const MEMBER_APPLICATIONS_TABLE = ownTable('member_applications');

/** 供新代码按语义取表名，避免手写字符串 */
export function tables() {
  return {
    admins: ADMINS_TABLE,
    appConfig: APP_CONFIG_TABLE,
    loginConfig: LOGIN_CONFIG_TABLE,
    settings: SETTINGS_TABLE,
    sessionRevocations: SESSION_REVOCATIONS_TABLE,
    configAudit: CONFIG_AUDIT_TABLE,
    memberApplications: MEMBER_APPLICATIONS_TABLE,
  } as const;
}

/** settings 表里的迁移标记：存在即表示两张配置表已是结构化形态 */
export const STRUCTURED_MIGRATION_MARKER = 'config.structured.v1';

/**
 * 旧 EAV 登录配置键前缀，只用于一次性迁移 SQL 里的 `LIKE 'auth.%'`。
 * 新结构化表按字段 id 直接读写，不再按 key 字符串路由。
 */
export const LOGIN_CONFIG_KEY_PREFIX = 'auth.';
