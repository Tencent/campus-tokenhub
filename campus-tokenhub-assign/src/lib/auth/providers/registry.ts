/**
 * 认证适配器注册表。
 *
 * 路由只通过 `getAuthAdapter()` 拿适配器：新增协议时在这里挂一行即可，
 * 登录页 / 发起登录 / 回调三处都不用改。
 */

import { getConfig, type AppConfig } from '@/lib/config';
import { assertAuthSafe } from '@/lib/config/auth-validate';
import { oauth2Adapter } from './oauth2';
import { casAdapter } from './cas';
import { wecomAdapter } from './wecom';
import type { AuthAdapter } from './types';

const ADAPTERS: Record<AppConfig['auth']['provider'], AuthAdapter> = {
  oauth2: oauth2Adapter,
  cas: casAdapter,
  wecom: wecomAdapter,
};

export function getAuthAdapter(cfg: AppConfig = getConfig()): AuthAdapter {
  // 认证决策汇聚点守卫：默认参数与显式传入的 cfg 都必须先校验（安全红线）
  assertAuthSafe(cfg.auth, process.env.NODE_ENV ?? '');
  return ADAPTERS[cfg.auth.provider];
}

/**
 * 取适配器抛出的错误码。路由只需要把 `code` 拼到 `/login?error=`，
 * 不关心具体是哪个错误类（标准 OAuth2 / CAS 适配器抛出的错误都带 code）。
 */
export function authErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code ? code : null;
}
