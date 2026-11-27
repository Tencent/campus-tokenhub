/**
 * 设置页的访问控制。
 *
 * 与「初始化」「运营活动配置」同一口径：全局管理员 = 本地引导账号 或 数据库名单命中。
 * 页面与接口共用，避免入口可见但接口 403。
 */

import { ApiError } from '@/lib/api/guard';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import type { SessionPayload } from '@/lib/auth/session';

export async function canManageSettings(session: SessionPayload): Promise<boolean> {
  return resolvePortalAdmin(session);
}

export async function requireSettingsAdmin(session: SessionPayload): Promise<void> {
  if (!(await canManageSettings(session))) {
    throw new ApiError(403, '设置仅对全局管理员开放', 'not_settings_admin');
  }
}
