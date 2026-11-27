/**
 * 运营活动配置的访问控制。
 *
 * 与「初始化」「管理后台」同一口径：全局管理员（数据库名单，名单为空时回落初始化 owner）。
 * 页面与接口共用这里，避免「侧边栏看得到入口、点进去被重定向 / 403」。
 */

import { ApiError } from '@/lib/api/guard';
import { isSetupAdmin } from '@/lib/onboarding/access';
import type { SessionPayload } from '@/lib/auth/session';

export async function canManageActivities(session: SessionPayload): Promise<boolean> {
  return isSetupAdmin(session);
}

export async function requireActivityAdmin(session: SessionPayload): Promise<void> {
  if (!(await canManageActivities(session))) {
    throw new ApiError(403, '运营活动配置仅对全局管理员开放', 'not_activity_admin');
  }
}
