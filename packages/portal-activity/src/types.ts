/**
 * 活动记录的公共类型。
 *
 * `site` 只允许两个值：写库时的 CHECK 约束与这里必须一致，
 * 站点由 `createActivityRecorder({ site })` 单点注入，调用方不再各自传字符串。
 */

/** 门户站点标识，与 `portal_shared.*.site` 的 CHECK 约束一一对应 */
export type ActivitySite = 'assign' | 'member';

/** 登录方式：SSO 取 `adapter.kind`，引导期账密固定 `password` */
export type LoginMethod = 'oauth2' | 'cas' | 'wecom' | 'password';

/** 一条登录事件的业务字段（站点与时间由 recorder 补齐） */
export type LoginEventInput = {
  /** 身份唯一标识（external_user_id），两站同源 */
  sub: string;
  name?: string | null;
  email?: string | null;
  method: LoginMethod;
};
