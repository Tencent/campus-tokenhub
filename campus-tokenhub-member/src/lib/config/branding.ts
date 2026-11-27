/**
 * 品牌与文案解析。
 *
 * 学校能改的东西（校名、登录页文案、页脚联系窗口、主题色、Logo）统一从这里取，
 * 页面不再写死字面量。取值优先级：登录身份带回的校名 > 运行期配置 > 默认值。
 *
 * 非法值（例如主题色写成 `red`）不抛错：回落到默认值并记进 `invalidKeys`，
 * 由设置页提示「这一项填写不合法」，而不是让登录页白屏。
 */

import { getConfig, type AppConfig } from '@/lib/config';
import type { ConfigField } from './fields';
import { brandLogoUrl } from './logo-url';
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_LOGIN_TITLE,
  DEFAULT_SCHOOL_NAME,
  HEX_COLOR,
} from './branding-defaults';

export { DEFAULT_BRAND_COLOR, DEFAULT_LOGIN_TITLE, DEFAULT_SCHOOL_NAME };

export type Branding = {
  schoolName: string;
  loginTitle: string;
  loginSubtitle: string;
  footerContact: string;
  brandColor: string;
  /** 为空表示未配置 Logo，页面用内置字标 */
  logoUrl: string;
  /** 配置存在但不合法的字段，供设置页提示 */
  invalidKeys: ConfigField[];
};

export type ResolveBrandingInput = {
  /** 登录时认证方返回的校名 */
  sessionSchoolName?: string | null;
  /** 测试注入；缺省读 `getConfig()` */
  config?: AppConfig;
};

function text(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveBranding(input: ResolveBrandingInput = {}): Branding {
  const config = input.config ?? getConfig();
  const portal = config.portal;
  const invalidKeys: ConfigField[] = [];

  const sessionSchoolName = text(input.sessionSchoolName);
  const configuredSchoolName = text(portal.schoolName);

  let brandColor = text(portal.brandColor);
  if (!brandColor) {
    brandColor = DEFAULT_BRAND_COLOR;
  } else if (!HEX_COLOR.test(brandColor)) {
    invalidKeys.push('brandColor');
    brandColor = DEFAULT_BRAND_COLOR;
  }

  const logo = text(portal.logo);
  if (logo && !logo.startsWith('data:image/')) {
    invalidKeys.push('logo');
  }

  return {
    schoolName: sessionSchoolName || configuredSchoolName || DEFAULT_SCHOOL_NAME,
    loginTitle: text(portal.loginTitle) || DEFAULT_LOGIN_TITLE,
    loginSubtitle: text(portal.loginSubtitle),
    footerContact: text(portal.footerContact),
    brandColor,
    logoUrl: brandLogoUrl(logo),
    invalidKeys,
  };
}
