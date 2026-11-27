/**
 * 门户会话：HS256 JWT 放进 HttpOnly Cookie，服务端无状态（无数据库）。
 *
 * 载荷里的 `octafuse_user_id` 允许为 null：开户失败也要能登录，
 * 由算力账户页引导「重试开通」，成功后重签会话补上这个字段。
 */

import { SignJWT, jwtVerify } from 'jose';
import { getConfig } from '@/lib/config';

export const SESSION_COOKIE = 'portal_session';

/** JWT 用途声明：登录事务 Cookie 与会话共用 SESSION_SECRET，靠这个 claim 防止互相冒充。 */
export const SESSION_PURPOSE = 'portal-session';

const ALG = 'HS256';

export type SessionIdentity = {
  /** external_user_id，默认取 IdP 返回的 sub */
  sub: string;
  email: string;
  name: string;
  /**
   * 学校名（登录时认证方返回）。只用于界面署名，取不到时留空，
   * 侧边栏回退到 `PORTAL_SCHOOL_NAME`。
   */
  schoolName?: string;
  /**
   * 是否为全局管理员（签发时按数据库管理员名单判定，名单是唯一来源）。
   * 只在 true 时写入 claim；缺席一律按非管理员处理。
   */
  admin?: boolean;
  /**
   * 登录方式。只有引导期账号密码登录写 `password`，SSO 会话保持缺席。
   * 请求期据此判断该会话是否已随「SSO 配齐」而失效（见 `isPasswordSessionAllowed`）。
   */
  loginMethod?: 'password';
};

/**
 * 会话载荷。
 *
 * ⚠️ 读写**不对称**，且这是有意设计：
 * - 写入端（member 站）不写 `octafuse_user_id`——本站没有网关开户流程；
 * - 读取端必须解析它——两站共用同一个 `SESSION_SECRET` 与 Cookie 名，
 *   统一采买站签发的会话要能在本站被正确解析（跨站互认，见 openspec design D6）。
 *   读不到时返回 `null`，对端据此判断「尚未开户」。
 *
 * 任何一侧单方面删掉读取分支，都会让互认在字段层面破掉。
 */
export type SessionPayload = {
  sub: string;
  email: string;
  name: string;
  /** 学校名；缺席表示认证方没返回，界面回退到配置 */
  school_name?: string;
  octafuse_user_id: string | null;
  /** 是否为白名单管理员；管理台只认 true，且要求签名有效。 */
  admin: boolean;
  /** 登录方式；只有引导期账号密码登录的会话带 `password` */
  login_method?: 'password';
  iat: number;
  exp: number;
};

export type SignOptions = {
  /** 默认取 SESSION_SECRET */
  secret?: string;
  /** 默认取 SESSION_TTL_HOURS */
  ttlHours?: number;
  now?: Date;
};

export type SessionCookie = {
  name: string;
  value: string;
  options: {
    httpOnly: boolean;
    sameSite: 'lax';
    path: string;
    /** 不设 = host-only（同域部署最安全）；跨子域互认时才设父域 */
    domain?: string;
    secure: boolean;
    maxAge: number;
  };
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(
  identity: SessionIdentity,
  options: SignOptions = {}
): Promise<string> {
  const cfg = getConfig();
  const secret = options.secret ?? cfg.auth.sessionSecret;
  const ttlHours = options.ttlHours ?? cfg.auth.sessionTtlHours;
  const now = options.now ?? new Date();

  return new SignJWT({
    purpose: SESSION_PURPOSE,
    sub: identity.sub,
    email: identity.email,
    name: identity.name,
    // 只在有值时才写入：认证方没返回校名时省略 claim，回退交给配置兜底
    ...(identity.schoolName ? { school_name: identity.schoolName } : {}),
    // 只在 true 时写入：非管理员留空，避免历史 token 出现 "admin: false" 的歧义
    ...(identity.admin === true ? { admin: true } : {}),
    // 只有引导期账号密码登录才写：SSO 会话保持缺席，避免多一个可伪造语义的字段
    ...(identity.loginMethod === 'password' ? { login_method: 'password' } : {}),
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(Math.floor(now.getTime() / 1000) + ttlHours * 3600)
    .sign(secretKey(secret));
}

/** 验签失败、过期、格式非法一律返回 null，交由调用方决定 302 还是 401。 */
export async function verifySession(
  token: string | null | undefined,
  options: { secret?: string } = {}
): Promise<SessionPayload | null> {
  if (!token) return null;

  const secret = options.secret ?? getConfig().auth.sessionSecret;

  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: [ALG] });

    // 用途必须明确是本门户会话：否则同密钥签出的 oidc_tx / 任意 JWT 都能冒充登录态。
    // sub 必须非空且为字符串：匿名拿到的 oidc_tx 没有 sub，不能借 provision 升级成正式会话。
    if (payload.purpose !== SESSION_PURPOSE) return null;
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
    if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) return null;

    return {
      sub: payload.sub,
      email: String(payload.email ?? ''),
      name: String(payload.name ?? ''),
      // 非法值（非字符串/空串）一律当缺席，避免把任意内容渲染到界面上
      ...(typeof payload.school_name === 'string' && payload.school_name.length > 0
        ? { school_name: payload.school_name }
        : {}),
      octafuse_user_id:
        typeof payload.octafuse_user_id === 'string' ? payload.octafuse_user_id : null,
      // 严格布尔：字符串 "true" 等真值不算管理员
      admin: payload.admin === true,
      // 严格字面量：只认 'password'，其余（含 'sso' 之类臆造值）当缺席，按 SSO 会话处理
      ...(payload.login_method === 'password' ? { login_method: 'password' as const } : {}),
      iat: Number(payload.iat),
      exp: Number(payload.exp),
    };
  } catch {
    return null;
  }
}



/**
 * 从原始 `Cookie` 请求头里拆出**所有**同名 `portal_session` 的值。
 *
 * 为什么不能用 `cookies().getAll()`：Next 的 RequestCookies 基于 Map，
 * 同名 Cookie 后者覆盖前者，`getAll` 只返回**一个**（实测为最后一个）。
 * 而浏览器在「同名不同 Path」时会同时发送多个（新版 `Path=/tokenhub`、
 * 旧版 `Path=/`），且 Path 更长的排在前面——于是 `getAll` 拿到的恰好是旧的、
 * 用旧密钥签的那个，验签失败，表现为「登录成功却立刻跳回登录页」的死循环。
 *
 * 这里直接按 `Cookie` 头原文拆，不经过任何去重逻辑。
 */
export function sessionTokensFromCookieHeader(
  header: string | null | undefined
): string[] {
  if (!header) return [];
  const prefix = `${SESSION_COOKIE}=`;
  return header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(prefix))
    .map((part) => {
      const raw = part.slice(prefix.length);
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    });
}

/**
 * 从多个同名 Cookie 值里挑出真正有效的那个会话。
 *
 * 为什么需要：浏览器允许同名不同 `Path` 的 Cookie 并存。
 * - 从旧版本升级上来：旧版 Cookie 是 `Path=/`，新版是 `Path=/tokenhub`，两者会同时发给服务端；
 * - 同一域名下先访问过旧版门户，也会留下一个旧密钥签的 `portal_session`。
 *
 * `cookies.get()` 只返回其中一个，如果拿到的是旧密钥签的那个，验签失败 →
 * 表现为「密码正确、登录成功，却立刻被踢回登录页」的死循环，且没有任何报错。
 * 这里逐个验签、取第一个有效的，升级用户不需要清浏览器缓存。
 */
export async function verifyAnySession(
  values: readonly string[],
  options: { secret?: string } = {}
): Promise<SessionPayload | null> {
  for (const value of values) {
    const session = await verifySession(value, options);
    if (session) return session;
  }
  return null;
}

/**
 * Cookie 属性只在这里拼，避免各路由各写一套导致 Secure 漏配。
 * V1 走 HTTP 直连 IP，`COOKIE_SECURE` 必须为 false，否则浏览器直接丢弃 Cookie。
 */
export function buildSessionCookie(token: string): SessionCookie {
  const cfg = getConfig();
  return {
    name: SESSION_COOKIE,
    value: token,
    options: {
      httpOnly: true,
      sameSite: 'lax',
      // 作用域由部署形态决定（见 config.portal.cookiePath / cookieDomain 的注释）：
      // 两站同域不同前缀时，path 必须是两站的**公共前缀**，否则各自存一份，互认断掉。
      path: cfg.portal.cookiePath,
      ...(cfg.portal.cookieDomain ? { domain: cfg.portal.cookieDomain } : {}),
      secure: cfg.auth.cookieSecure,
      maxAge: cfg.auth.sessionTtlHours * 3600,
    },
  };
}

export function clearSessionCookie(): SessionCookie {
  const { name, options } = buildSessionCookie('');
  return { name, value: '', options: { ...options, maxAge: 0 } };
}

/**
 * 清掉旧部署写在**根路径**的会话 Cookie（`Path=/`）。
 *
 * 前缀化之前的版本把 `portal_session` 写在 `/`，升级后同一个浏览器会同时带两条同名
 * Cookie：新的是 `Path=/tokenhub`，旧的是 `Path=/`。只按名字取一条的读取方可能拿到旧的，
 * 表现为「登录成功却被判未登录」。读取点虽已改成逐个验签，这里再从源头把旧 Cookie 清掉。
 *
 * 只能手写 `Set-Cookie` 头：`ResponseCookies` 以 name 为键，写第二条会把第一条顶掉，
 * 导致刚签发的会话被清空。根路径部署（`PORTAL_COOKIE_PATH=/`）无需清理，直接跳过。
 *
 * 调用顺序必须排在普通 `response.cookies.set(...)` **之后**：Next 每次 set 都会重写
 * 整个 `set-cookie` 头，追加早了会被覆盖。
 */
export function clearLegacyRootSessionCookie(
  response: { headers: Headers },
  cookie: SessionCookie
): void {
  if (cookie.options.path === '/') return;

  const attributes = [
    `${cookie.name}=`,
    'Path=/',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(cookie.options.domain ? [`Domain=${cookie.options.domain}`] : []),
    'HttpOnly',
    'SameSite=Lax',
    ...(cookie.options.secure ? ['Secure'] : []),
  ];
  response.headers.append('set-cookie', attributes.join('; '));
}

/**
 * 从 Cookie 头里取会话并验签；供 Route Handler / middleware 共用。
 *
 * 走 `sessionTokensFromCookieHeader` + `verifyAnySession`：同名 Cookie 并存时逐个验签
 * （只取第一个会在密钥轮换后误判成未登录），且解码失败不会抛 URIError——
 * 畸形 Cookie 是客户端可控输入，不能让它把请求打成 500。
 */
export async function sessionFromCookieHeader(
  cookieHeader: string | null | undefined
): Promise<SessionPayload | null> {
  return verifyAnySession(sessionTokensFromCookieHeader(cookieHeader));
}
