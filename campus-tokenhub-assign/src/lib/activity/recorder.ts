/**
 * 活动记录器实例（统一采买站）。
 *
 * 站点标识在这里单点写死：两站是复制关系，`site` 写反不会报错，
 * 只会让看板把两站数据串在一起，所以只允许在实例化时出现一次。
 *
 * 数据库惰性注入：本地纯前端调试可以不配 `PORTAL_DATABASE_URL`，
 * 此时 `db()` 抛错会被 recorder 内部捕获并按「未配置」静默，不影响登录。
 */

import { createActivityRecorder } from '@campus/portal-activity';
import { getDb, isPortalDbConfigured } from '@/lib/db/portal-db';
import { isActivityEnabled } from './enabled';

export const activityRecorder = createActivityRecorder({
  site: 'assign',
  db: () => {
    if (!isPortalDbConfigured()) throw new Error('PORTAL_DATABASE_URL 未配置');
    return getDb();
  },
  // 设置页开关关闭时，recorder 内部直接短路，不产生任何 SQL
  isEnabled: isActivityEnabled,
});
