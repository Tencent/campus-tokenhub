/**
 * 业务时区：全站「今天」「高峰时段」「活动周期」共用一个口径。
 *
 * 为什么必须统一：用量看板按网关下发的 `BUSINESS_TIMEZONE` 切日，
 * 而价格窗口 / 活动日期 / 时间格式化早期各自写死 `Asia/Shanghai`。
 * 学校把网关时区改成香港/新加坡后，两边会在跨零点时错开一天。
 *
 * 取值顺序：环境变量 `BUSINESS_TIMEZONE` → `Asia/Shanghai`（默认）。
 * 纯函数模块（价格、活动规则）不走运行期配置中心，所以这里只读环境变量，
 * 与网关的 `system_config.BUSINESS_TIMEZONE` 由部署方保持一致。
 */

export const DEFAULT_BUSINESS_TIME_ZONE = 'Asia/Shanghai';

export function businessTimeZone(): string {
  const configured = (process.env.BUSINESS_TIMEZONE ?? '').trim();
  return configured || DEFAULT_BUSINESS_TIME_ZONE;
}
