/**
 * 品牌默认值（浏览器安全）。
 *
 * 客户端组件（登录页预览、侧边栏）只需要这几个常量与颜色正则，
 * 不能顺着 `branding.ts → config.ts → overlay` 把 `pg` 拉进浏览器包。
 */

export const DEFAULT_BRAND_COLOR = '#2557D6';
export const DEFAULT_LOGIN_TITLE = '登录 MaaS工作台';
export const DEFAULT_SCHOOL_NAME = '学校';

/** 允许 #rgb / #rrggbb */
export const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
