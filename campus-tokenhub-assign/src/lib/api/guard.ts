/**
 * 写操作三件套：会话、同源、方法。
 *
 * - 会话：Cookie JWT 验签失败即 401（页面由 middleware 兜，这里兜 API）
 * - 同源：浏览器对 POST 一定带 Origin，与 Host 不一致直接 403，防 CSRF
 * - 方法：只允许显式声明的方法，其余 405
 *
 * 三种失败统一成 `ApiError`，路由里只写 `try/catch + jsonError`。
 */

import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { sessionTokensFromCookieHeader, verifyAnySession, type SessionPayload } from '@/lib/auth/session';
import { isSessionRevoked } from '@/lib/auth/revocation';
import { isPasswordSessionAllowed } from '@/lib/auth/local-admin';
import { refreshConfigOverlay } from '@/lib/config/overlay';
import { maskSecrets } from '@/lib/audit';

export type ApiErrorOptions = {
  /**
   * 真实原因（网关/上游返回的那句话）。
   *
   * 只走服务端日志时它是最重要的排障线索：`provision_failed` 这种泛化 code 只能说明
   * 「失败了」，说明不了「为什么失败」（网关登录被拒 / 超时 / 上游 HTTP 码）。
   */
  detail?: string | null;
  /**
   * 是否把 `detail` 随响应体下发（字段名 `reason`）。
   *
   * 默认不下发：`detail` 可能是上游原文，含内网地址、容器名或上游实现细节，
   * 学生侧没有排障诉求。调用方确认「当前请求者可以看」时（如管理员）再置 true。
   */
  exposeDetail?: boolean;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | null;
  readonly exposeDetail: boolean;

  constructor(status: number, message: string, code = 'api_error', options: ApiErrorOptions = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = options.detail?.trim() ? options.detail.trim() : null;
    this.exposeDetail = options.exposeDetail === true;
  }
}

/** 网关侧的失败映射到 502，且不把原始 message 直接透给学生时用它包一层。 */
export function jsonError(error: unknown): NextResponse {
  const requestId = randomId();

  if (error instanceof ApiError) {
    // `request_id` 只有和日志对得上才有意义：这里把 detail 打出来，运维拿响应头里的
    // x-request-id 就能直接从容器日志里捞到这一次失败的真实原因。
    // 先脱敏再打：detail 可能夹带上游原文，不能保证里面没有凭证。
    if (error.detail) {
      console.error('[api] 请求失败', {
        requestId,
        status: error.status,
        code: error.code,
        detail: maskSecrets(error.detail),
        exposeDetail: error.exposeDetail,
      });
    }

    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        request_id: requestId,
        // 管理员排障才带原因；学生侧连字段都不出现，避免把上游细节当成「页面报错」暴露出去
        ...(error.detail && error.exposeDetail ? { reason: maskSecrets(error.detail) } : {}),
      },
      { status: error.status, headers: noStoreHeaders(requestId) }
    );
  }

  // 未预期的异常必须留痕：数据库不可用 / SQL 报错 / 上游结构变化都走这里，
  // 只回一句「服务暂时不可用」会让线上排障完全失去线索
  console.error('[api] 未处理异常', {
    requestId,
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  return NextResponse.json(
    { error: '服务暂时不可用，请稍后重试', code: 'internal_error', request_id: requestId },
    { status: 500, headers: noStoreHeaders(requestId) }
  );
}

/** 敏感响应（密钥、手机号、名单）一律不缓存，并带上排障用的 request id。 */
export function jsonNoStore(
  data: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): NextResponse {
  const requestId = randomId();
  return NextResponse.json(data, {
    status: init.status,
    headers: { ...noStoreHeaders(requestId), ...(init.headers ?? {}) },
  });
}

function noStoreHeaders(requestId: string): Record<string, string> {
  return { 'cache-control': 'no-store, private', 'x-request-id': requestId };
}

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function assertMethod(request: Request, allowed: string[]): void {
  if (!allowed.includes(request.method)) {
    throw new ApiError(405, `仅支持 ${allowed.join(' / ')}`, 'method_not_allowed');
  }
}

/**
 * 开发环境额外打印被拒绝的来源。
 *
 * 线上只回 403 就够了，但本地排查「点了按钮却 403」时必须知道浏览器实际发的
 * Origin 与可接受的 host 差在哪（`localhost` / `127.0.0.1` / IDE 预览沙箱）。
 */
function warnOriginRejected(origin: string | null, expectedHosts: string[], reason?: string): void {
  if (process.env.NODE_ENV === 'production') return;
  console.warn('[same-origin] 来源校验失败', {
    origin,
    expectedHosts,
    ...(reason ? { reason } : {}),
  });
}

/**
 * 只比较 host，不比较协议：V1 可能跑在反向代理后面（浏览器 https、门户 http）。
 * 没有 Origin 头说明不是浏览器发起的，浏览器跨站请求必带 Origin，故不拦。
 *
 * 可接受的基准有**两个**，命中任一即放行：
 *
 * 1. 请求的 `Host`：浏览器真实访问的目标，JS 改不了它。跨站攻击者的 Origin 是自己站点、
 *    Host 是受害者站点，两者必然不一致 → 仍然拒绝。这也是管理台 CSRF 的判定方式
 *    （见 `deploy/nginx.conf.template` 里保留外部 Host 的注释）。
 * 2. 配置的 `PUBLIC_BASE_URL`：反代改写 Host 的场景（例如 nginx 把 Host 换成容器名）。
 *
 * 同时接受两者是因为 **Host 才是浏览器实际连的地址**，而配置只有一个：本地 docker 里
 * `PUBLIC_BASE_URL` 往往还指着线上域名，浏览器在 `localhost:3000` 访问时若只按配置比对，
 * 所有写接口都会被误判成跨源（实测门户所有写操作 403）。
 *
 * **不要**用 `X-Forwarded-Host`：该头浏览器/客户端可以自带，用它做基准等于让人
 * 自己证明自己是同源（同父域站点 + SameSite=Lax 会带 Cookie，可直接绕过）。
 */
export function assertSameOrigin(request: Request): void {
  // 先看 `Sec-Fetch-Site`：它是浏览器写入的 forbidden header，页面脚本改不了，
  // 而且比 `Origin` 更不容易缺失——跨站表单提交在部分浏览器/代理链路上会把 Origin
  // 省略掉（那时下面的 `if (!origin) return` 会直接放行），但 Sec-Fetch-Site 仍写着
  // `cross-site`。所以这一条专门补「Origin 缺失但确实是跨站」的缺口。
  //
  // 只拒绝 `cross-site`：`same-site`（同父域不同子域）、`none`（地址栏直接访问）与
  // 缺失都继续走下面的 Origin 全等校验。同站子域的攻击会被 host 不等拦掉，不必在这里
  // 一刀切——那样会误伤「门户与管理台不同子域」的部署形态。
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    warnOriginRejected(null, [], 'sec-fetch-site: cross-site');
    throw new ApiError(403, '来源校验失败', 'origin_mismatch');
  }

  const origin = request.headers.get('origin');
  if (!origin) return;

  if (origin === 'null') {
    warnOriginRejected('null', []);
    throw new ApiError(403, '来源校验失败', 'origin_mismatch');
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    warnOriginRejected(origin, []);
    throw new ApiError(403, '来源校验失败', 'origin_mismatch');
  }

  const configured = getConfig().portal.publicBaseUrl;
  const expectedHosts = [
    request.headers.get('host'),
    configured ? new URL(configured).host : null,
  ].filter((host): host is string => Boolean(host));

  if (!expectedHosts.includes(originHost)) {
    warnOriginRejected(origin, expectedHosts);
    throw new ApiError(403, '来源校验失败', 'origin_mismatch');
  }
}

export async function requireSession(request: Request): Promise<SessionPayload> {
  // 与 middleware / 服务端页面同一口径：同名 Cookie 可能并存（新旧 Path 各一个、
  // 甚至一个是换密钥前签的），必须逐个验签取第一个有效的。
  // 这里曾经只取 `find()` 到的第一个：浏览器把旧 Cookie 排在前面时，页面能进、
  // API 全 401，表现为「登录成功但操作都失败」，排障时完全没有线索。
  const session = await verifyAnySession(
    sessionTokensFromCookieHeader(request.headers.get('cookie'))
  );
  if (!session) throw new ApiError(401, '未登录或会话已过期', 'unauthenticated');

  // 已登出 / 被吊销的会话：签名仍然有效，但服务端已记录吊销时间点
  if (await isSessionRevoked(session)) {
    throw new ApiError(401, '登录状态已失效，请重新登录', 'unauthenticated');
  }

  // 引导期密码会话：SSO 配齐（或运维显式关闭）后立即不再放行。
  // 这里**强制重读**配置而不是用内存快照：快照有 30 秒 TTL，多副本下刚配完 SSO 的
  // 瞬间仍可能读到旧值，等于给已关闭的入口留了一个宽限窗口。只有密码会话付这次读库成本。
  if (session.login_method === 'password') {
    await refreshConfigOverlay();
    if (!isPasswordSessionAllowed(session)) {
      throw new ApiError(401, '登录状态已失效，请重新登录', 'unauthenticated');
    }
  }
  return session;
}

/** 已登录但网关账号还没开出来时，写操作一律 409，引导去「重试开通」。 */
export function requireOctafuseUserId(session: SessionPayload): string {
  if (!session.octafuse_user_id) {
    throw new ApiError(409, '账号正在开通中，请稍后重试', 'not_provisioned');
  }
  return session.octafuse_user_id;
}
