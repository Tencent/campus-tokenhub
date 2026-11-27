/**
 * 标准 OAuth2 授权码适配器（直接对接学校 / IdP，不经任何中间门户）。
 *
 * 发起：跳 `authorizationEndpoint?client_id&redirect_uri&response_type=code&scope&state`。
 * 回调：拿 `code` 到 `tokenEndpoint` 换 token，再到 `userInfoEndpoint` 读身份。
 * token 端点认证方式与 userinfo 携带方式都可配，以兼容不同 IdP。
 *
 * 网络调用走依赖注入，单测不碰外网。
 */

import type { AppConfig, OAuth2AuthConfig } from '@/lib/config';
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

export type OAuth2Deps = {
  fetch?: typeof fetch;
  exchangeToken?: (params: {
    config: OAuth2AuthConfig;
    code: string;
    codeVerifier: string;
  }) => Promise<string>;
  fetchUserInfo?: (params: {
    config: OAuth2AuthConfig;
    accessToken: string;
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

/**
 * 把协议参数拼到授权端点上。
 *
 * 授权页可能是 SPA 的 hash 路由（`https://host/learning/#/login/oauth2?corp_code=...`），
 * 这种情况下参数必须追加到 `#` 之后的查询串里，并保留原有的 `corp_code` 等参数；
 * 普通 URL 仍然走标准 query，行为不变。
 */
function appendAuthParams(endpoint: string, params: Record<string, string>): string {
  const hashIndex = endpoint.indexOf('#');
  if (hashIndex === -1) {
    const url = new URL(endpoint);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  const base = endpoint.slice(0, hashIndex);
  const fragment = endpoint.slice(hashIndex + 1);
  const queryIndex = fragment.indexOf('?');
  const path = queryIndex === -1 ? fragment : fragment.slice(0, queryIndex);
  const search = new URLSearchParams(queryIndex === -1 ? '' : fragment.slice(queryIndex + 1));
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return `${base}#${path}?${search.toString()}`;
}

export function buildOAuth2AuthorizationUrl(
  config: OAuth2AuthConfig,
  tx: { state: string; codeChallenge: string },
  redirectUri: string
): string {
  const scopes = config.scopes.trim() || 'openid profile email';
  // PKCE S256：标准 OAuth2 授权码的推荐做法；IdP 不支持时忽略该参数即可
  return appendAuthParams(config.authorizationEndpoint, {
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    state: tx.state,
    scope: scopes,
    code_challenge: tx.codeChallenge,
    code_challenge_method: 'S256',
  });
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 上游的错误描述：优先 err_msg，其次 error_description / error，最后 err_code */
function upstreamError(json: Record<string, unknown> | null): string {
  if (!json) return '';
  const fields = ['err_msg', 'error_description', 'error', 'err_code', 'message'];
  for (const key of fields) {
    const value = json[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export async function exchangeOAuth2Token(input: {
  config: OAuth2AuthConfig;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { config, code, codeVerifier, redirectUri } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (config.tokenAuthMethod === 'client_secret_basic') {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  } else {
    body.set('client_id', config.clientId);
    body.set('client_secret', config.clientSecret);
  }

  let response: Response;
  try {
    // token 端点由管理员在设置页填写：这里带着 client_secret 发请求，
    // 被改成 http://127.0.0.1:... 或云元数据地址就等于把学校凭据送出去
    const guarded = await assertOutboundAllowed(config.tokenEndpoint, 'token 端点');
    if (!guarded.ok) throw new AuthFlowError('endpoint_blocked', guarded.message);

    response = await fetchImpl(config.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof AuthFlowError) throw error;
    throw new AuthFlowError(
      'token_exchange_failed',
      `请求 token 端点失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const json = await readJson(response);
  if (!response.ok || !json || typeof json.access_token !== 'string' || !json.access_token) {
    // 上游原因（如 InvalidGrant / code已失效）只进服务端日志，便于排端点、密钥与回调地址的问题
    const upstream = upstreamError(json);
    throw new AuthFlowError(
      'token_exchange_failed',
      `token 端点返回异常：${response.status}${upstream ? ` ${upstream}` : ''}`
    );
  }
  return json.access_token;
}

export async function fetchOAuth2UserInfo(input: {
  config: OAuth2AuthConfig;
  accessToken: string;
  fetchImpl?: typeof fetch;
}): Promise<Record<string, unknown>> {
  const { config, accessToken } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const url = new URL(config.userInfoEndpoint);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (config.userInfoTokenCarrier === 'query') {
    url.searchParams.set('access_token', accessToken);
  } else {
    headers.authorization = `Bearer ${accessToken}`;
  }

  let response: Response;
  try {
    const guarded = await assertOutboundAllowed(url.toString(), '用户信息端点');
    if (!guarded.ok) throw new AuthFlowError('endpoint_blocked', guarded.message);

    response = await fetchImpl(url.toString(), { headers, cache: 'no-store' });
  } catch (error) {
    if (error instanceof AuthFlowError) throw error;
    throw new AuthFlowError(
      'user_info_failed',
      `请求用户信息端点失败：${error instanceof Error ? error.message : String(error)}`
    );
  }
  const json = await readJson(response);
  if (!response.ok || !json) {
    const upstream = upstreamError(json);
    throw new AuthFlowError(
      'user_info_failed',
      `用户信息端点返回异常：${response.status}${upstream ? ` ${upstream}` : ''}`
    );
  }
  return json;
}

export async function completeOAuth2Authorization(input: {
  config: OAuth2AuthConfig;
  auth: AppConfig['auth'];
  tx: StoredLoginTransaction | null;
  callback: CallbackParams;
  redirectUri: string;
  deps?: OAuth2Deps;
}): Promise<Identity> {
  const { config, auth, tx, callback, redirectUri, deps = {} } = input;
  requireTransaction(tx, callback);
  if (!callback.code) throw new AuthFlowError('code_missing', '认证回调缺少授权码 code');

  const exchange = deps.exchangeToken ?? exchangeOAuth2Token;
  const loadUserInfo = deps.fetchUserInfo ?? fetchOAuth2UserInfo;
  const accessToken = await exchange({
    config,
    code: callback.code,
    codeVerifier: tx?.codeVerifier ?? '',
    redirectUri,
  });
  const claims = await loadUserInfo({ config, accessToken });
  return establishIdentity({ auth, claims, fieldMap: config.fieldMap });
}

/** 适配层入口：标准 OAuth2 授权码。 */
export const oauth2Adapter: AuthAdapter = {
  kind: 'oauth2',
  requiresRedirect: true,
  label: '使用学校账号登录',
  start: async ({ request, config, tx }: StartLoginInput) =>
    buildOAuth2AuthorizationUrl(config.auth.oauth2, tx, authCallbackUrl(request)),
  complete: async ({ request, config, tx, callback }: CompleteLoginInput) =>
    completeOAuth2Authorization({
      config: config.auth.oauth2,
      auth: config.auth,
      tx,
      callback,
      redirectUri: authCallbackUrl(request),
    }),
};
