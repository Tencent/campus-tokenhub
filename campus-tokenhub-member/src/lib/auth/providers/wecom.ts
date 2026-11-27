/**
 * 企业微信自建应用（CorpApp）认证适配器。
 *
 * 企微客户端内走官方网页授权（91022），PC 端扫码参数由 `buildWecomQrLoginUrl`
 * 提供给登录组件。回调统一在服务端完成：gettoken → getuserinfo → 资料补全 →
 * 交给 `establishIdentity()` 校验登录限制并产出 Identity。
 *
 * 网络调用走依赖注入，单测不碰外网；Secret 只用于内存缓存 key 与 gettoken 请求，
 * 不写日志、不进接口响应。
 */

import { createHash } from 'node:crypto';
import type { AppConfig, WecomAuthConfig } from '@/lib/config';
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

const AUTHORIZE_URL = 'https://open.weixin.qq.com/connect/oauth2/authorize';
const QR_LOGIN_URL = 'https://login.work.weixin.qq.com/wwlogin/sso/login';
const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const TOKEN_EXPIRY_BUFFER_SECONDS = 300;
const TOKEN_MIN_TTL_SECONDS = 60;
const TOKEN_INVALID_CODES = new Set([42001, 40014]);

/** 企微客户端判定：UA 含 wxwork 才走网页授权，空值 / 普通浏览器都走 PC 扫码 */
export function isWecomClient(ua: string | null): boolean {
  return typeof ua === 'string' && /wxwork/i.test(ua);
}

export type WecomDeps = {
  fetch?: typeof fetch;
};

export type WecomCredentials = Pick<WecomAuthConfig, 'corpId' | 'agentId' | 'secret'>;

export type WecomUserInfo = {
  errcode?: number;
  errmsg?: string;
  userid?: string;
  openid?: string;
  user_ticket?: string;
};

export type WecomProfile = {
  name?: string;
  email?: string;
  avatar?: string;
  department?: unknown;
  position?: string;
  mobile?: string;
};

type TokenEntry = {
  token: string;
  expiresAt: number;
  pending?: Promise<string>;
};

/** 进程内缓存：key 含 Secret 指纹，轮换后自然落到新 key */
const tokenCache = new Map<string, TokenEntry>();

function tokenCacheKey(params: WecomCredentials): string {
  const fingerprint = createHash('sha256').update(params.secret).digest('hex').slice(0, 8);
  return `${params.corpId}:${params.agentId}:${fingerprint}`;
}

function clearTokenCache(params: WecomCredentials): void {
  tokenCache.delete(tokenCacheKey(params));
}

function requireTransaction(
  tx: StoredLoginTransaction | null,
  callback: Pick<CallbackParams, 'state' | 'error'>
): void {
  if (!tx) throw new AuthFlowError('tx_missing');
  if (!callback.state || callback.state !== tx.state) {
    throw new AuthFlowError('state_mismatch');
  }
  if (callback.error) throw new AuthFlowError('access_denied');
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function errcodeOf(json: Record<string, unknown> | null): number {
  return Number(json?.errcode ?? 0);
}

function upstreamMessage(json: Record<string, unknown> | null): string {
  return typeof json?.errmsg === 'string' ? json.errmsg : '';
}

/** 上游原因只进服务端日志：不拼接 Secret，也不回显到登录页 */
function warnUpstream(action: string, response: Response | null, json: Record<string, unknown> | null): void {
  console.warn(`[wecom] ${action} failed`, {
    status: response?.status ?? null,
    errcode: json ? json.errcode : null,
    errmsg: json ? json.errmsg : null,
  });
}

/** 企微网页授权：#wechat_redirect 必须是 fragment，不能作为 query 被编码 */
export function buildWecomAuthorizationUrl(
  config: WecomAuthConfig,
  tx: { state: string },
  redirectUri: string
): string {
  const query = [
    `appid=${encodeURIComponent(config.corpId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    'response_type=code',
    `scope=${encodeURIComponent(config.scope)}`,
    `state=${encodeURIComponent(tx.state)}`,
    `agentid=${encodeURIComponent(config.agentId)}`,
  ].join('&');
  const url = new URL(`${AUTHORIZE_URL}?${query}`);
  url.hash = 'wechat_redirect';
  return url.toString();
}

/** PC 扫码组件参数（redirect_uri 由组件自行编码，这里给出标准登录入口 URL） */
export function buildWecomQrLoginUrl(
  config: WecomAuthConfig,
  tx: { state: string },
  redirectUri: string
): string {
  const query = [
    'login_type=CorpApp',
    `appid=${encodeURIComponent(config.corpId)}`,
    `agentid=${encodeURIComponent(config.agentId)}`,
    `redirect_uri=${encodeURIComponent(redirectUri)}`,
    `state=${encodeURIComponent(tx.state)}`,
    'redirect_type=callback',
  ].join('&');
  return `${QR_LOGIN_URL}?${query}`;
}

/** gettoken；命中缓存直接返回，并发共享同一个在途 Promise */
export async function getWecomAccessToken(
  params: WecomCredentials,
  deps: WecomDeps = {}
): Promise<string> {
  const key = tokenCacheKey(params);
  const cached = tokenCache.get(key);
  if (cached) {
    if (cached.pending) return cached.pending;
    if (Date.now() < cached.expiresAt) return cached.token;
    tokenCache.delete(key);
  }

  const pending = (async () => {
    const url = new URL(`${API_BASE}/gettoken`);
    url.searchParams.set('corpid', params.corpId);
    url.searchParams.set('corpsecret', params.secret);
    const fetchImpl = deps.fetch ?? fetch;

    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { cache: 'no-store' });
    } catch (error) {
      console.warn('[wecom] gettoken request failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw new AuthFlowError('wecom_token_failed');
    }
    const json = await readJson(response);
    const errcode = errcodeOf(json);
    const errmsg = upstreamMessage(json);
    const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
    if (!response.ok || errcode !== 0 || !accessToken) {
      warnUpstream('gettoken', response, json);
      throw new AuthFlowError('wecom_token_failed');
    }

    const expiresIn = Number(json?.expires_in);
    const ttl = Math.max(
      Number.isFinite(expiresIn) ? expiresIn - TOKEN_EXPIRY_BUFFER_SECONDS : 0,
      TOKEN_MIN_TTL_SECONDS
    );
    tokenCache.set(key, { token: accessToken, expiresAt: Date.now() + ttl * 1000 });
    return accessToken;
  })();

  tokenCache.set(key, { token: '', expiresAt: 0, pending });
  try {
    return await pending;
  } catch (error) {
    // 只在失败请求仍是当前在途项时清理，避免覆盖后续成功写入的 token
    if (tokenCache.get(key)?.pending === pending) tokenCache.delete(key);
    throw error;
  }
}

export type WecomUserIdParams = WecomCredentials & {
  accessToken: string;
  code: string;
};

/** auth/getuserinfo；42001 / 40014 清缓存换 token 后重试一次 */
export async function getWecomUserId(
  params: WecomUserIdParams,
  deps: WecomDeps = {}
): Promise<WecomUserInfo> {
  const fetchImpl = deps.fetch ?? fetch;
  const call = async (accessToken: string): Promise<{ response: Response; json: Record<string, unknown> | null }> => {
    const url = new URL(`${API_BASE}/auth/getuserinfo`);
    url.searchParams.set('access_token', accessToken);
    url.searchParams.set('code', params.code);
    let response: Response;
    try {
      response = await fetchImpl(url.toString(), { cache: 'no-store' });
    } catch (error) {
      console.warn('[wecom] getuserinfo request failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      throw new AuthFlowError('wecom_userinfo_failed');
    }
    return { response, json: await readJson(response) };
  };

  let { response, json } = await call(params.accessToken);
  if (TOKEN_INVALID_CODES.has(errcodeOf(json))) {
    warnUpstream('getuserinfo token invalid', response, json);
    clearTokenCache(params);
    const freshToken = await getWecomAccessToken(params, deps);
    ({ response, json } = await call(freshToken));
    if (!response.ok || TOKEN_INVALID_CODES.has(errcodeOf(json))) {
      warnUpstream('getuserinfo retry', response, json);
      throw new AuthFlowError('wecom_token_failed');
    }
  }

  if (!response.ok || errcodeOf(json) !== 0 || !json) {
    warnUpstream('getuserinfo', response, json);
    throw new AuthFlowError('wecom_userinfo_failed');
  }
  return {
    ...(typeof json.userid === 'string' && json.userid ? { userid: json.userid } : {}),
    ...(typeof json.openid === 'string' && json.openid ? { openid: json.openid } : {}),
    ...(typeof json.user_ticket === 'string' && json.user_ticket
      ? { user_ticket: json.user_ticket }
      : {}),
  };
}

export type WecomProfileParams = WecomCredentials & {
  accessToken: string;
  userid?: string;
  userTicket?: string;
  user_ticket?: string;
};

/** 资料补全：user_ticket 优先，否则 user/get；失败只告警并降级为空对象 */
export async function fetchWecomProfile(
  params: WecomProfileParams,
  deps: WecomDeps = {}
): Promise<WecomProfile> {
  const ticket = params.userTicket ?? params.user_ticket;
  if (!ticket && !params.userid) return {};
  const fetchImpl = deps.fetch ?? fetch;

  try {
    let response: Response;
    if (ticket) {
      const url = new URL(`${API_BASE}/auth/getuserdetail`);
      url.searchParams.set('access_token', params.accessToken);
      response = await fetchImpl(url.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user_ticket: ticket }),
        cache: 'no-store',
      });
    } else {
      const url = new URL(`${API_BASE}/user/get`);
      url.searchParams.set('access_token', params.accessToken);
      url.searchParams.set('userid', params.userid ?? '');
      response = await fetchImpl(url.toString(), { cache: 'no-store' });
    }

    const json = await readJson(response);
    if (!response.ok || errcodeOf(json) !== 0 || !json) {
      warnUpstream('profile', response, json);
      return {};
    }
    const profile: WecomProfile = {};
    for (const key of ['name', 'email', 'avatar', 'position', 'mobile'] as const) {
      const value = json[key];
      if (typeof value === 'string' && value.trim()) profile[key] = value;
    }
    if (json.department !== undefined) profile.department = json.department;
    return profile;
  } catch (error) {
    console.warn('[wecom] profile request failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

/** 回调收尾：校验事务 → 换身份 → 补全资料 → 交给公共身份解析 */
export async function completeWecomAuthorization(
  input: CompleteLoginInput,
  deps: WecomDeps = {}
): Promise<Identity> {
  const { config, tx, callback } = input;
  requireTransaction(tx, callback);
  if (!callback.code) throw new AuthFlowError('code_missing');

  const wecom = config.auth.wecom;
  if (!wecom.corpId?.trim() || !wecom.agentId?.trim() || !wecom.secret?.trim()) {
    throw new AuthFlowError('wecom_config_missing');
  }
  const credentials: WecomCredentials = {
    corpId: wecom.corpId,
    agentId: wecom.agentId,
    secret: wecom.secret,
  };

  const accessToken = await getWecomAccessToken(credentials, deps);
  const userInfo = await getWecomUserId(
    { ...credentials, accessToken, code: callback.code },
    deps
  );
  // 非企业成员只有 openid：fail closed，绝不签发会话
  if (!userInfo.userid) {
    if (userInfo.openid) throw new AuthFlowError('wecom_not_member');
    throw new AuthFlowError('wecom_userinfo_failed');
  }

  const profile = await fetchWecomProfile(
    {
      ...credentials,
      accessToken,
      userid: userInfo.userid,
      ...(userInfo.user_ticket ? { userTicket: userInfo.user_ticket } : {}),
    },
    deps
  );
  const claims: Record<string, unknown> = {
    sub: userInfo.userid,
    userid: userInfo.userid,
    // 供「登录限制」自定义字段路径使用（设置页示例 corp_id 即指向此值）
    corp_id: wecom.corpId,
    ...(userInfo.openid ? { openid: userInfo.openid } : {}),
    ...profile,
  };
  return establishIdentity({ auth: config.auth, claims });
}

/** 适配层入口：企业微信自建应用。 */
export const wecomAdapter: AuthAdapter = {
  kind: 'wecom',
  requiresRedirect: true,
  label: '使用企业微信登录',
  start: async ({ request, config, tx }: StartLoginInput) =>
    buildWecomAuthorizationUrl(config.auth.wecom, tx, authCallbackUrl(request)),
  complete: async (input: CompleteLoginInput) => completeWecomAuthorization(input),
};
