/**
 * 设置页的访问控制。
 *
 * 与「初始化」「运营活动配置」同一口径：全局管理员（数据库名单，名单为空时回落
 * 初始化 owner）。页面与接口共用，避免入口可见但接口 403。
 */

import { ApiError } from '@/lib/api/guard';
import { isSetupAdmin } from '@/lib/onboarding/access';
import type { SessionPayload } from '@/lib/auth/session';

export async function canManageSettings(session: SessionPayload): Promise<boolean> {
  return isSetupAdmin(session);
}

export async function requireSettingsAdmin(session: SessionPayload): Promise<void> {
  if (!(await canManageSettings(session))) {
    throw new ApiError(403, '设置仅对全局管理员开放', 'not_settings_admin');
  }
}
