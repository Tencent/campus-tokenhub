/**
 * 认证适配层的公共契约。
 *
 * 路由只认 `AuthAdapter`，不认具体协议：新增一种登录方式 = 实现这两个方法
 * （发起跳转 / 回调换身份）并注册到 `providers/registry.ts`。
 *
 * 当前实现：
 * - `oauth2`：标准 OAuth2 授权码（授权 / token / userinfo 端点可配）；
 * - `cas`：标准 CAS（认证地址 + Ticket 校验地址）；
 * - `wecom`：企业微信自建应用（企微内网页授权 + PC 内嵌扫码）。
 */

import type { AppConfig } from '@/lib/config';

export type Identity = {
  /** external_user_id，写进网关的 external_user_id */
  sub: string;
  email: string;
  name: string;
  /**
   * 学校名，由认证方返回（userinfo / CAS 属性的 school_name）。
   * 取不到时留空，侧边栏回退到 `PORTAL_SCHOOL_NAME` 配置。
   */
  schoolName?: string;
  /**
   * 认证方返回的角色（已按「角色」字段映射解析，去重）。
   * 用于登录时按配置把命中角色的账号加入管理员名单；不写入会话。
   */
  roles?: string[];
};

/** 一次登录事务：发起时生成、写进签名 Cookie，回调时取出比对。 */
export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  /** PKCE challenge，只在发起阶段用到，不落 Cookie */
  codeChallenge: string;
  /** 登录成功后回到站内哪一页 */
  next: string;
  /** 登录完成的落点：门户站内（默认）还是管理台 */
  dest?: 'portal' | 'admin';
  /** `dest=admin` 时管理台内的深链接（已净化，只可能是站内相对路径） */
  adminNext?: string;
};

/** 签名 Cookie 里能恢复出来的部分（PKCE challenge 不需要回传）。 */
export type StoredLoginTransaction = Omit<LoginTransaction, 'codeChallenge'>;

/**
 * 认证回调参数：不同协议携带的字段不同（OAuth2 是 code，CAS 直连是
 * ticket 或 token），在这里统一收口，由各适配器自行取用。
 */
export type CallbackParams = {
  code?: string | null;
  state?: string | null;
  ticket?: string | null;
  token?: string | null;
  error?: string | null;
  errorDescription?: string | null;
};

export type StartLoginInput = {
  request: Request;
  config: AppConfig;
  tx: LoginTransaction;
};

export type CompleteLoginInput = {
  request: Request;
  config: AppConfig;
  tx: StoredLoginTransaction | null;
  callback: CallbackParams;
};

export interface AuthAdapter {
  readonly kind: AppConfig['auth']['provider'];
  /** 是否走外部跳转 + 回调（当前两种 SSO 协议都为 true） */
  readonly requiresRedirect: boolean;
  /** 登录页按钮文案 */
  readonly label: string;
  /** 发起登录，返回要跳转的地址 */
  start(input: StartLoginInput): Promise<string>;
  /** 回调收尾，返回登录身份 */
  complete(input: CompleteLoginInput): Promise<Identity>;
}

/**
 * 适配层通用错误：`code` 直接作为 `/login?error=` 的值，由
 * `login-errors.ts` 翻译成中文。各适配器也可以抛自己的错误类，只要带 `code`。
 */
export class AuthFlowError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'AuthFlowError';
    this.code = code;
  }
}
