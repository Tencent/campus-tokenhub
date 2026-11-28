/**
 * 活动记录器实例（成员自购站）。
 *
 * 与统一采买站唯一不同的是 `site`；该值是看板的站点维度依据，
 * 只允许在这里出现一次，避免复制代码时写反。
 *
 * 数据库惰性注入：未配置 `PORTAL_DATABASE_URL` 时静默降级，不影响登录。
 */

import { createActivityRecorder } from '@campus/portal-activity';
import { getDb, isPortalDbConfigured } from '@/lib/db/portal-db';
import { isActivityEnabled } from './enabled';

export const activityRecorder = createActivityRecorder({
  site: 'member',
  db: () => {
    if (!isPortalDbConfigured()) throw new Error('PORTAL_DATABASE_URL 未配置');
    return getDb();
  },
  // 设置页开关关闭时，recorder 内部直接短路，不产生任何 SQL
  isEnabled: isActivityEnabled,
});
