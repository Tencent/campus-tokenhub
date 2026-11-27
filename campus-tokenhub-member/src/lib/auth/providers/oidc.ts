/**
 * OIDC 授权码 + PKCE（S256）。
 *
 * 无数据库，所以 `state` / `nonce` / `code_verifier` / `next` 全部塞进一枚 10 分钟过期的
 * 签名 Cookie（`oidc_tx`），回调时再取出来比对。网络与验签都做了依赖注入，单元测试不碰外网。
 */

import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import { assertOutboundAllowed } from '@/lib/security/url-guard';
import type {
  Identity,
  LoginTransaction,
  StoredLoginTransaction,
} from './types';

/** OIDC 底层参数（OIDC 不再作为可选协议；仅 tx Cookie / 工具函数仍在用） */
export type OidcAuthParams = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export const OIDC_TX_COOKIE = 'oidc_tx';
export const OIDC_TX_TTL_SECONDS = 600;
export const OIDC_SCOPE = 'openid profile email';

/** JWT 用途声明：与 portal_session 共用 SESSION_SECRET，靠这个 claim 相互隔离。 */
export const OIDC_TX_PURPOSE = 'oidc-tx';

/** 签名 Cookie 里能恢复的部分 */
export type OidcTx = StoredLoginTransaction;

/** 发起登录时多带一个算好的 challenge，签名落 Cookie 时不需要它 */
export type OidcTransaction = LoginTransaction;

export type OidcCallbackParams = {
  code?: string | null;
  state?: string | null;
  error?: string | null;
};

export type ExchangeTokenParams = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
};

export type OidcDeps = {
  /** 用授权码换 id_token；默认走标准 token 端点 */
  exchangeToken?: (params: ExchangeTokenParams) => Promise<string>;
  /** 校验 id_token 并返回 claims；默认按 issuer 的 JWKS 验签 */
  verifyIdToken?: (
    idToken: string,
    expected: { issuer: string; audience: string }
  ) => Promise<Record<string, unknown>>;
};

export type OidcErrorCode =
  | 'access_denied'
  | 'tx_missing'
  | 'state_mismatch'
  | 'code_missing'
  | 'token_exchange_failed'
  | 'id_token_invalid'
  | 'nonce_mismatch'
  /** 端点地址指向本机 / 云元数据：配置被改坏或被利用做 SSRF 时统一走这条 */
  | 'endpoint_blocked';

export class OidcError extends Error {
  readonly code: OidcErrorCode;

  constructor(code: OidcErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'OidcError';
    this.code = code;
  }
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function randomToken(byteLength = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** PKCE：verifier 随机，challenge = BASE64URL(SHA256(verifier))。 */
export async function createPkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const codeVerifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return { codeVerifier, codeChallenge: base64url(new Uint8Array(digest)) };
}

export async function createOidcTx(next: string): Promise<OidcTransaction> {
  const { codeVerifier, codeChallenge } = await createPkcePair();
  return { state: randomToken(24), nonce: randomToken(24), codeVerifier, codeChallenge, next };
}

/**
 * 授权端点优先用发现文档给出的 `authorization_endpoint`（Keycloak / Azure AD 等都不在
 * `/authorize`）；没传时回落到 `{issuer}/authorize`。
 * 端点必须与 issuer 同源，避免发现文档被篡改后把授权码发到站外。
 */
export function buildAuthorizationUrl(
  auth: Pick<OidcAuthParams, 'issuer' | 'clientId' | 'redirectUri'>,
  tx: Pick<OidcTx, 'state' | 'nonce'> & { codeChallenge: string },
  authorizationEndpoint?: string
): string {
  const issuer = new URL(auth.issuer);
  // 不传端点时保持原有 `{issuer}/authorize` 语义（issuer 可带 realm / tenant 路径）
  const endpoint = authorizationEndpoint
    ? new URL(authorizationEndpoint)
    : new URL(`${auth.issuer.replace(/\/+$/, '')}/authorize`);

  if (endpoint.origin !== issuer.origin) {
    throw new OidcError('token_exchange_failed', '授权端点与 issuer 不同源');
  }

  const url = endpoint;
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', auth.clientId);
  url.searchParams.set('redirect_uri', auth.redirectUri);
  url.searchParams.set('scope', OIDC_SCOPE);
  url.searchParams.set('state', tx.state);
  url.searchParams.set('nonce', tx.nonce);
  url.searchParams.set('code_challenge', tx.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function signOidcTx(tx: OidcTx, secret: string): Promise<string> {
  return new SignJWT({
    purpose: OIDC_TX_PURPOSE,
    state: tx.state,
    nonce: tx.nonce,
    codeVerifier: tx.codeVerifier,
    next: tx.next,
    // 管理台目标：与 state 一起签名，回调时不可被篡改
    ...(tx.dest === 'admin' ? { dest: 'admin', adminNext: tx.adminNext ?? '/' } : {}),
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${OIDC_TX_TTL_SECONDS}s`)
    .sign(new TextEncoder().encode(secret));
}

export async function verifyOidcTx(token: string | null | undefined, secret: string): Promise<OidcTx | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ['HS256'],
    });
    // 只接受本用途的 token：portal_session 不能被拿来当登录事务用
    if (payload.purpose !== OIDC_TX_PURPOSE) return null;
    if (
      typeof payload.state !== 'string' ||
      typeof payload.nonce !== 'string' ||
      typeof payload.codeVerifier !== 'string'
    ) {
      return null;
    }
    // 管理台目标：只接受「单个斜杠开头的站内相对路径」，其余一律收敛为根路径
    const adminNextRaw = typeof payload.adminNext === 'string' ? payload.adminNext.trim() : '';
    const adminNext =
      adminNextRaw.startsWith('/') &&
      !adminNextRaw.startsWith('//') &&
      !adminNextRaw.startsWith('/\\') &&
      !/[\u0000-\u001f]/.test(adminNextRaw)
        ? adminNextRaw
        : '/';

    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
      next: typeof payload.next === 'string' ? payload.next : '/overview',
      ...(payload.dest === 'admin' ? { dest: 'admin' as const, adminNext } : {}),
    };
  } catch {
    return null;
  }
}

export function buildOidcTxCookie(token: string, secure: boolean) {
  return {
    name: OIDC_TX_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure,
      maxAge: OIDC_TX_TTL_SECONDS,
    },
  };
}

export function clearOidcTxCookie(secure: boolean) {
  const { name } = buildOidcTxCookie('', secure);
  return {
    name,
    value: '',
    options: {
      httpOnly: true,
      sameSite: 'lax' as const,
      path: '/',
      secure,
      maxAge: 0,
    },
  };
}

type DiscoveryDocument = {
  token_endpoint: string;
  jwks_uri: string;
  authorization_endpoint?: string;
};

const discoveryCache = new Map<string, Promise<DiscoveryDocument>>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * 清空进程内的 discovery 与 JWKS 缓存。
 *
 * 运行期改 `auth.oidc.issuer` / `auth.provider` 后调用，否则会继续用旧 IdP 的
 * 发现文档与验签公钥（多副本下由各副本在 overlay 刷新时各自检测并清理）。
 */
export function clearOidcDiscoveryCache(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

async function discover(issuer: string): Promise<DiscoveryDocument> {
  const base = issuer.replace(/\/+$/, '');
  const cached = discoveryCache.get(base);
  if (cached) return cached;

  // issuer 是管理员在设置页填的地址，服务端会照着它发请求：先挡掉本机 / 云元数据，
  // 否则把 issuer 改成 http://169.254.169.254/... 就等于给了一个读实例凭证的入口。
  const guarded = await assertOutboundAllowed(base, 'OIDC issuer');
  if (!guarded.ok) throw new OidcError('endpoint_blocked', guarded.message);

  const pending = (async () => {
    const response = await fetch(`${base}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) {
      throw new OidcError('token_exchange_failed', `发现文档读取失败：${response.status}`);
    }
    return (await response.json()) as DiscoveryDocument;
  })().catch((error) => {
    discoveryCache.delete(base);
    throw error;
  });

  discoveryCache.set(base, pending);
  return pending;
}

/**
 * 取发现文档里的授权端点。登录发起阶段多一次（带缓存的）发现文档读取；
 * 读不到就返回 undefined，由 buildAuthorizationUrl 回落到 `{issuer}/authorize`，
 * 避免把「发现文档暂时不可用」放大成「整个登录入口 500」。
 */
export async function discoverAuthorizationEndpoint(issuer: string): Promise<string | undefined> {
  try {
    const doc = await discover(issuer);
    return typeof doc.authorization_endpoint === 'string' ? doc.authorization_endpoint : undefined;
  } catch {
    return undefined;
  }
}

async function defaultExchangeToken(params: ExchangeTokenParams): Promise<string> {
  const { token_endpoint } = await discover(params.issuer);
  // 发现文档由 IdP 提供，但地址仍可能被指向内网：换 token 会带上 client_secret，
  // 打错地方等于把学校凭据送出去
  const guarded = await assertOutboundAllowed(token_endpoint, 'OIDC token_endpoint');
  if (!guarded.ok) throw new OidcError('endpoint_blocked', guarded.message);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body,
  });

  if (!response.ok) {
    throw new OidcError('token_exchange_failed', `换取 token 失败：${response.status}`);
  }

  const json = (await response.json()) as { id_token?: string };
  if (!json.id_token) {
    throw new OidcError('token_exchange_failed', 'token 响应缺少 id_token');
  }
  return json.id_token;
}

async function defaultVerifyIdToken(
  idToken: string,
  expected: { issuer: string; audience: string }
): Promise<Record<string, unknown>> {
  const { jwks_uri } = await discover(expected.issuer);
  let jwks = jwksCache.get(jwks_uri);
  if (!jwks) {
    // JWKS 地址同样来自发现文档：拉公钥前先确认不是本机 / 元数据地址
    const guarded = await assertOutboundAllowed(jwks_uri, 'OIDC jwks_uri');
    if (!guarded.ok) throw new OidcError('endpoint_blocked', guarded.message);
    jwks = createRemoteJWKSet(new URL(jwks_uri));
    jwksCache.set(jwks_uri, jwks);
  }

  const { payload } = await jwtVerify(idToken, jwks, {
    issuer: expected.issuer,
    audience: expected.audience,
  });
  return payload as Record<string, unknown>;
}

/**
 * 常量时间字符串比较。
 *
 * `state` 与 `nonce` 都是从 IdP 回调回来的外部输入，用 `!==` 比较会在第一个不同字符处
 * 提前返回，把「匹配了多少前缀」泄漏出去。两者其实都是 24 字节随机 token，暴力成本已经
 * 不可行，这里只是把比较方式统一到安全一侧，不承担主要防线。
 *
 * **不用 `node:crypto` 的 `timingSafeEqual`**：本模块刻意只依赖 Web Crypto
 * （见上面的 `crypto.subtle.digest`），以便在 edge 运行时也能加载；`node:crypto`
 * 在 edge 不可用，换成它会把这条兼容性打断。
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

/**
 * 回调收尾：校验 state → 换 token → 验 id_token 与 nonce → 产出身份。
 * 任何一步不合规都抛 `OidcError`，由路由统一转成 `/login?error=`。
 */
export async function completeAuthorization(input: {
  auth: OidcAuthParams;
  tx: OidcTx | null;
  callback: OidcCallbackParams;
  deps?: OidcDeps;
}): Promise<Identity> {
  const { auth, tx, callback, deps = {} } = input;

  if (callback.error) {
    throw new OidcError('access_denied', `IdP 返回错误：${callback.error}`);
  }
  if (!tx) {
    throw new OidcError('tx_missing', '登录事务已过期，请重新登录');
  }
  if (!callback.state || !constantTimeEqual(callback.state, tx.state)) {
    throw new OidcError('state_mismatch', 'state 不匹配');
  }
  if (!callback.code) {
    throw new OidcError('code_missing', '回调缺少 code');
  }

  const exchangeToken = deps.exchangeToken ?? defaultExchangeToken;
  const verifyIdToken = deps.verifyIdToken ?? defaultVerifyIdToken;

  let idToken: string;
  try {
    idToken = await exchangeToken({
      issuer: auth.issuer,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      redirectUri: auth.redirectUri,
      code: callback.code,
      codeVerifier: tx.codeVerifier,
    });
  } catch (error) {
    if (error instanceof OidcError) throw error;
    throw new OidcError('token_exchange_failed', '换取 token 失败');
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyIdToken(idToken, { issuer: auth.issuer, audience: auth.clientId });
  } catch {
    throw new OidcError('id_token_invalid', 'id_token 校验失败');
  }

  // id_token 里的 nonce 可能缺失或非字符串：缺失一律按不匹配处理（不能因为
  // constantTimeEqual 收到 undefined 就放行）
  if (typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, tx.nonce)) {
    throw new OidcError('nonce_mismatch', 'nonce 不匹配');
  }

  const sub = typeof claims.sub === 'string' ? claims.sub : '';
  if (!sub) {
    throw new OidcError('id_token_invalid', 'id_token 缺少 sub');
  }

  const email = typeof claims.email === 'string' ? claims.email : '';
  const name =
    (typeof claims.name === 'string' && claims.name) ||
    (typeof claims.preferred_username === 'string' && claims.preferred_username) ||
    email ||
    sub;

  return { sub, email, name };
}
