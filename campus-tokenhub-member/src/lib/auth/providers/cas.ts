/**
 * 标准 CAS 适配器（直接对接学校 CAS Server，不经 aie-portal 之类的中间门户）。
 *
 * 发起：跳 `loginUrl?service=<回调地址带 state>`。
 * 回调：CAS Server 带 `ticket` 回来，服务端拿 ticket 到 `ticketValidateUrl` 校验，
 *       从校验响应（XML serviceValidate 或 JSON）中读取用户与属性。
 *
 * 网络调用走依赖注入，单测不碰外网。
 */

import type { AppConfig, CasAuthConfig } from '@/lib/config';
import { assertOutboundAllowed } from '@/lib/security/url-guard';
import type {
  AuthAdapter,
  CallbackParams,
  CompleteLoginInput,
  Identity,
  StartLoginInput,
  StoredLoginTransaction,
} from './types';
import { AuthFlowError } from './types';
import { establishIdentity } from './identity';
import { authCallbackUrl } from '../login';

export type CasDeps = {
  fetch?: typeof fetch;
  validateTicket?: (params: {
    config: CasAuthConfig;
    ticket: string;
    service: string;
  }) => Promise<Record<string, unknown>>;
};

function requireTransaction(tx: StoredLoginTransaction | null, callback: CallbackParams): void {
  if (!tx) {
    throw new AuthFlowError('tx_missing', '登录事务 Cookie 缺失或已过期，请从登录页重新发起');
  }
  if (!callback.state || callback.state !== tx.state) {
    throw new AuthFlowError('state_mismatch', '回调 state 与登录事务不匹配，请重新发起登录');
  }
  if (callback.error) {
    throw new AuthFlowError(
      'access_denied',
      callback.errorDescription || `认证服务返回错误：${callback.error}`
    );
  }
}

/** CAS 的 service 必须与发起登录时完全一致，state 由门户附加并由 CAS 原样带回 */
export function buildCasServiceUrl(redirectUri: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

export function buildCasAuthorizationUrl(
  config: CasAuthConfig,
  state: string,
  redirectUri: string
): string {
  const url = new URL(config.loginUrl);
  url.searchParams.set('service', buildCasServiceUrl(redirectUri, state));
  return url.toString();
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/** 从 CAS serviceValidate XML 中取 `authenticationSuccess` 下的 user 与属性 */
export function parseCasXml(xml: string): Record<string, unknown> {
  if (/<[\w:-]*authenticationFailure[\s>]/i.test(xml)) {
    throw new AuthFlowError('ticket_invalid', 'CAS 票据校验失败');
  }
  if (!/<[\w:-]*authenticationSuccess[\s>]/i.test(xml)) {
    throw new AuthFlowError('user_info_failed', 'CAS 校验响应格式无法识别');
  }
  const success = xml.match(/<[\w:-]*authenticationSuccess[\s>][\s\S]*?<\/[\w:-]*authenticationSuccess>/i)?.[0] ?? xml;
  const claims: Record<string, unknown> = {};

  const user = success.match(/<[\w:-]*user[\s>]([\s\S]*?)<\/[\w:-]*user>/i)?.[1];
  if (user) claims.user = decodeXml(user);

  const attrsBlock = success.match(/<[\w:-]*attributes[\s>]([\s\S]*?)<\/[\w:-]*attributes>/i)?.[1] ?? '';
  const attrPattern = /<([A-Za-z][\w:.-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;
  while ((match = attrPattern.exec(attrsBlock)) !== null) {
    const name = match[1].replace(/^.*:/, '');
    const value = decodeXml(match[2]);
    if (!value) continue;
    if (claims[name] === undefined) claims[name] = value;
    else if (Array.isArray(claims[name])) (claims[name] as string[]).push(value);
    else claims[name] = [claims[name] as string, value];
  }
  if (!claims.sub && claims.user) claims.sub = claims.user;
  return claims;
}

/** JSON 形态：`{ serviceResponse: { authenticationSuccess: { user, attributes } } }` */
export function parseCasJson(json: Record<string, unknown>): Record<string, unknown> {
  const outer = (json.serviceResponse ?? json) as Record<string, unknown>;
  const success = outer.authenticationSuccess;
  if (!success || typeof success !== 'object') {
    throw new AuthFlowError('ticket_invalid', 'CAS 票据校验失败');
  }
  const body = success as Record<string, unknown>;
  const attributes =
    body.attributes && typeof body.attributes === 'object'
      ? (body.attributes as Record<string, unknown>)
      : {};
  const claims: Record<string, unknown> = { ...attributes };
  if (typeof body.user === 'string' && body.user) {
    claims.user = body.user;
    if (!claims.sub) claims.sub = body.user;
  }
  return claims;
}

export async function validateCasTicket(input: {
  config: CasAuthConfig;
  ticket: string;
  service: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const { config, ticket, service } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(config.ticketValidateUrl);
  url.searchParams.set('ticket', ticket);
  url.searchParams.set('service', service);

  let response: Response;
  try {
    // 校验端点由管理员填写，且请求里带 ticket（一次性凭证）：
    // 被指向本机端口或云元数据就等于把票据与内网可达性一起交出去
    const guarded = await assertOutboundAllowed(url.toString(), 'CAS 校验端点');
    if (!guarded.ok) throw new AuthFlowError('endpoint_blocked', guarded.message);

    response = await fetchImpl(url.toString(), {
      headers: { accept: 'application/xml, application/json' },
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof AuthFlowError) throw error;
    throw new AuthFlowError(
      'user_info_failed',
      `请求 CAS 校验端点失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    throw new AuthFlowError('user_info_failed', `CAS 校验端点返回异常：${response.status}`);
  }
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      json = null;
    }
    if (!json) throw new AuthFlowError('user_info_failed', 'CAS 校验响应不是合法 JSON');
    return parseCasJson(json);
  }
  return parseCasXml(trimmed);
}

export async function completeCasAuthorization(input: {
  config: CasAuthConfig;
  auth: AppConfig['auth'];
  tx: StoredLoginTransaction | null;
  callback: CallbackParams;
  redirectUri: string;
  deps?: CasDeps;
}): Promise<Identity> {
  const { config, auth, tx, callback, redirectUri, deps = {} } = input;
  requireTransaction(tx, callback);
  if (!callback.ticket) throw new AuthFlowError('ticket_missing', '统一认证回调缺少票据 ticket');

  const service = buildCasServiceUrl(redirectUri, tx?.state ?? '');
  const validate = deps.validateTicket ?? validateCasTicket;
  const claims = await validate({ config, ticket: callback.ticket, service });
  return establishIdentity({ auth, claims });
}

/** 适配层入口：标准 CAS。 */
export const casAdapter: AuthAdapter = {
  kind: 'cas',
  requiresRedirect: true,
  label: '使用学校统一认证登录',
  start: async ({ request, config, tx }: StartLoginInput) =>
    buildCasAuthorizationUrl(config.auth.cas, tx.state, authCallbackUrl(request)),
  complete: async ({ request, config, tx, callback }: CompleteLoginInput) =>
    completeCasAuthorization({
      config: config.auth.cas,
      auth: config.auth,
      tx,
      callback,
      redirectUri: authCallbackUrl(request),
    }),
};
