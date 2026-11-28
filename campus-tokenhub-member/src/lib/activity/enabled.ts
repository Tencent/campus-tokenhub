/**
 * 「登录数据统计」总开关。
 *
 * 唯一事实来源是门户设置页的「登录数据统计」开关（`portal_shared.app_config.activity_enabled`），
 * 缺省为 NULL，即**关闭**。关闭时：
 * - 登录事件与页面访问都不写库（recorder 短路）；
 * - 上报接口直接 204，不碰数据库；
 * - 布局不挂 `VisitTracker`，浏览器端连请求都不发。
 *
 * 读配置失败按关闭处理：统计缺失优于把配置层错误带进登录/浏览路径。
 */

import { readStoredConfig } from '@/lib/config/store';

export async function isActivityEnabled(): Promise<boolean> {
  try {
    const stored = await readStoredConfig();
    return stored.app.activityEnabled === true;
  } catch {
    return false;
  }
}
