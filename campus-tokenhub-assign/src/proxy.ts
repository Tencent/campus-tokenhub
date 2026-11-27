import { NextResponse, type NextRequest } from 'next/server';
import { getBaseConfig, getPublicProxyBase } from '@/lib/config';
import { sessionTokensFromCookieHeader, verifyAnySession } from '@/lib/auth/session';
import { portalUrl } from '@/lib/auth/login';
import { clientIpFromHeaders } from '@/lib/net/client-ip';

/**
 * 路由保护 + 安全响应头 + 粗粒度限流。
 *
 * - 会话：没会话的人只能看登录页、认证回调与健康检查；验签失败等同于未登录。
 * - 响应头：全站兜 CSP / 防嵌套 / 防 MIME 嗅探（`next.config` 的 `headers()` 只在构建期
 *   求值，而 CSP 的 connect-src 需要运行期才知道的 Proxy 地址，所以放在 middleware）。
 * - 限流：只兜「单点狂刷」这一层；真正的限流仍建议在反向代理按 IP 做。
 *   已登录请求按用户计数，避免全校走同一个出口 IP 时互相挤掉。
 *
 * 用 Node.js 运行时，保证能读到运行期注入的 SESSION_SECRET 等环境变量。
 */

const PUBLIC_PATHS = ['/login'];
const PUBLIC_PREFIXES = [
  '/api/auth',
  '/api/health',
  // 学校 Logo：登录页本身公开，图片再要求会话就会在登录页裂图；内容不含用户数据
  '/api/portal/branding',
];
/**
 * 终端里跑的「一条命令接入」接口：curl / iex 不带 Cookie，身份靠请求头里的 Key 自证，
 * 因此在 middleware 层不做会话校验，改为按 IP 限流（见入口处的 wb: 计数）。
 */
const WORKBUDDY_SCRIPT_PREFIX = '/api/portal/workbuddy/';

function isPublic(pathname: string): boolean {
  if (PUBLIC_PATHS.includes(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

// ---------------------------------------------------------------- 安全响应头

let cachedHeaders: Record<string, string> | null = null;

/**
 * CSP 的 script-src 必须留 `'unsafe-inline'`：Next 把 RSC flight 数据写成内联 script。
 * 因此这层 CSP 挡的主要是「外域脚本 / iframe 嵌套 / object 插件」，不是万能 XSS 防护。
 */
function securityHeaders(): Record<string, string> {
  if (cachedHeaders) return cachedHeaders;

  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  };

  // 开发模式下 Turbopack 依赖 eval / ws，套严格 CSP 只会把本地开发搞坏
  if (process.env.NODE_ENV === 'production') {
    // 调试台由浏览器持 Key 直连 Proxy，必须把它的地址放进 connect-src
    const proxyBase = getPublicProxyBase();
    // 企微官方登录组件域名常驻放行：middleware 只读 env，无法按 DB 里的 provider 动态放行
    const wecomFrameSrc = 'https://login.work.weixin.qq.com https://open.work.weixin.qq.com';
    const wecomScriptSrc = 'https://wwcdn.weixin.qq.com https://open.work.weixin.qq.com';
    const wecomConnectSrc =
      'https://login.work.weixin.qq.com https://open.work.weixin.qq.com https://wwcdn.weixin.qq.com';
    // CSP 的 source 不以 `/` 结尾时只匹配**精确路径**：写成 `https://host/tokenhub`
    // 拦不住调试台真正要访问的 `https://host/tokenhub/v1/chat/completions`。
    // `getPublicProxyBase()` 已去掉尾斜杠，这里补回来。
    const connectSrc = ["'self'", proxyBase ? `${proxyBase}/` : '', wecomConnectSrc]
      .filter(Boolean)
      .join(' ');

    headers['content-security-policy'] = [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      `frame-src 'self' ${wecomFrameSrc}`,
      `script-src 'self' 'unsafe-inline' ${wecomScriptSrc}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      `connect-src ${connectSrc}`,
    ].join('; ');

    try {
      // 用 env-only 快照：middleware 每个请求都跑，不能在这里触发数据库读取
      if (getBaseConfig().portal.publicBaseUrl.startsWith('https://')) {
        headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
      }
    } catch {
      // 配置非法时由 instrumentation 负责让进程退出，这里不额外抛错
    }
  }

  cachedHeaders = headers;
  return headers;
}

function apply(response: NextResponse, isDocument = false): NextResponse {
  for (const [name, value] of Object.entries(securityHeaders())) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  // 页面响应放宽到 same-origin（见 isDocumentPath 注释），接口响应保持 no-referrer
  if (isDocument) response.headers.set('referrer-policy', 'same-origin');
  return response;
}

/**
 * 页面（非 `/api/` 的文档响应）的 Referrer-Policy 必须是 `same-origin`。
 *
 * 全站默认是 `no-referrer`，但 Chrome 在 `no-referrer` 下会把**表单 POST** 的 `Origin`
 * 置成 `null`（实测：同一份表单，`no-referrer` 下 Origin=null，`same-origin` 下 Origin=http://host）。
 * 页面里的原生表单提交（登录页登录、侧边栏「退出登录」）都要靠 Origin 做同源校验，
 * Origin 被判成 `null` 就会 403「来源校验失败」。
 *
 * 之前只给登录页单独放宽，结果「退出登录」按钮照样 403 —— 它挂在已登录页面的侧边栏上，
 * 拿的是全站默认值。所以改成按「是不是文档响应」一刀切：页面 `same-origin`（站外仍不带
 * Referer），接口（JSON，不承载表单）继续 `no-referrer`。
 */
function isDocumentPath(pathname: string): boolean {
  return !pathname.startsWith('/api/');
}

// ------------------------------------------------------------------- 限流

type Limit = { limit: number; windowMs: number };

const LIMITS = {
  /** 已登录用户：密钥 / 开户 / 读取 Key，按用户计数 */
  portalUser: { limit: 240, windowMs: 60_000 },
  /** 未登录打 API：正常浏览器不会这样，收紧到每分钟 60 次 */
  portalAnon: { limit: 60, windowMs: 60_000 },
  /** 引导期账密登录：暴力破解面，收紧到 20 次/分钟/IP */
  passwordAuth: { limit: 20, windowMs: 60_000 },
  /**
   * SSO 回调：这是正常登录流，学校出口常常是同一个 NAT IP。
   * 若与 password 共用一个 10~20 次/分钟的桶，一次机房课或家长会集中登录就会把整校挡在门外，
   * 因此单独放宽到 60 次/分钟/IP。
   */
  callbackAuth: { limit: 60, windowMs: 60_000 },
} satisfies Record<string, Limit>;

/** 进程内固定窗口计数；多副本时各副本各算一份，够挡住单机刷 */
const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 5000;

/** 清掉已过期桶；返回是否腾出了空间。 */
function sweep(now: number): boolean {
  for (const [key, bucket] of buckets) {
    if (now >= bucket.resetAt) buckets.delete(key);
  }
  return buckets.size < MAX_BUCKETS;
}

/**
 * 仍然满时按插入顺序淘汰最旧的一批（Map 迭代顺序 = 插入顺序）。
 *
 * 之前只有 sweep，窗口内全是新 key 时 Map 会无上限增长：
 * 配合可伪造的 XFF 就能被打成内存放大 + 每次新 key 全表扫描。
 */
function evictOldest(target: number): void {
  for (const key of buckets.keys()) {
    if (buckets.size <= target) break;
    buckets.delete(key);
  }
}

function hit(key: string, { limit, windowMs }: Limit): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    if (buckets.size >= MAX_BUCKETS && !sweep(now)) {
      evictOldest(MAX_BUCKETS - 1);
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (bucket.count >= limit) return false;
  bucket.count += 1;
  return true;
}

/**
 * 认证端点的独立桶。
 *
 * 这两个前缀在 `isPublic()` 里是免会话的，不单独限流就等于「免认证 + 无限次」：
 * `/api/auth/password` 是暴力破解面，`/api/auth/callback` 每次失败都会向上游 IdP 发 token 请求。
 * 刻意**不包含** `/api/auth/check`（管理台每次加载都会调）与 `/login` 页面本身，避免限死正常流程。
 */
const AUTH_LIMIT_RULES: readonly { prefix: string; key: string; rule: Limit }[] = [
  { prefix: '/api/auth/password', key: 'auth:pwd', rule: LIMITS.passwordAuth },
  { prefix: '/api/auth/callback', key: 'auth:cb', rule: LIMITS.callbackAuth },
];

function authLimitFor(pathname: string): { key: string; rule: Limit } | null {
  const matched = AUTH_LIMIT_RULES.find(
    (item) => pathname === item.prefix || pathname.startsWith(`${item.prefix}/`)
  );
  return matched ? { key: matched.key, rule: matched.rule } : null;
}

/**
 * 取客户端 IP。
 * 反向代理必须**覆写** X-Forwarded-For（而不是追加），否则客户端自带该头即可绕过限流。
 * 具体实现与审计共用（`lib/net/client-ip.ts`），部署侧见 `deploy/nginx.conf.template`。
 */
function clientIp(request: NextRequest): string {
  return clientIpFromHeaders(request.headers);
}

function tooMany(): NextResponse {
  return apply(
    NextResponse.json(
      { error: '请求过于频繁，请稍后再试', code: 'rate_limited' },
      { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } }
    )
  );
}

// ------------------------------------------------------------- 老域名跳转

/** 域名迁移前的对外域名；迁移后只作为跳转入口，不再发新链接。 */
const LEGACY_HOST = 'api.aiedu.tencent.com';

/**
 * 模型代理接口：老域名上必须继续可用。
 * 学生端 SDK / WorkBuddy 的 `base_url` 已经固化成 `https://api.aiedu.tencent.com/tokenhub/v1`，
 * 跟着整站跳到新域名等于让存量客户端全部失效。与 `deploy/nginx.conf.template` 的
 * `$legacy_redirect` 规则保持一致（只放行 `/tokenhub/v1` 及其子路径）。
 */
const MODEL_API_PREFIX = '/tokenhub/v1';

/**
 * 老域名请求整站 308 到新域名，保留路径与 query。
 *
 * 线上统一入口的 nginx 已做这件事；这里兜的是门户单独部署（没有那层 nginx）的场景。
 * 目标只取 `PUBLIC_BASE_URL` 的 origin，不信任 Host / X-Forwarded-Host，避免开放重定向；
 * 两者 host 相同（配置还没切）时不跳，防止循环。
 */
function legacyDomainRedirect(request: NextRequest): NextResponse | null {
  const host = (request.headers.get('host') ?? '').split(':', 1)[0].toLowerCase();
  if (host !== LEGACY_HOST) return null;

  // request.url 的 pathname 是浏览器实际请求的路径（含部署前缀）；
  // 不能用 nextUrl.clone()：standalone 下它的 origin 是进程内部监听地址。
  const incoming = new URL(request.url);

  // 模型代理接口不跳（见 MODEL_API_PREFIX 注释）
  if (incoming.pathname === MODEL_API_PREFIX || incoming.pathname.startsWith(`${MODEL_API_PREFIX}/`)) {
    return null;
  }

  let publicBase: string;
  try {
    publicBase = getBaseConfig().portal.publicBaseUrl;
  } catch {
    return null;
  }
  if (!publicBase) return null;

  let target: URL;
  try {
    target = new URL(publicBase);
  } catch {
    return null;
  }
  if (target.hostname.toLowerCase() === host) return null;

  // request.url 的 pathname 是浏览器实际请求的路径（含部署前缀）；
  // 不能用 nextUrl.clone()：standalone 下它的 origin 是进程内部监听地址。
  const destination = new URL(incoming.pathname + incoming.search, target.origin);
  return apply(NextResponse.redirect(destination, 308));
}

// ------------------------------------------------------------------- 入口

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // 必须先于会话校验：老域名上的 Cookie 属于旧域，先走登录逻辑会把用户带错地方。
  const legacyRedirect = legacyDomainRedirect(request);
  if (legacyRedirect) return legacyRedirect;

  const { pathname } = request.nextUrl;

  // 无会话的公开接口，单独限流，避免被当作免费脚本生成器刷
  if (pathname.startsWith(WORKBUDDY_SCRIPT_PREFIX)) {
    if (!hit(`wb:${clientIp(request)}`, LIMITS.portalAnon)) return tooMany();
    return apply(NextResponse.next());
  }

  if (isPublic(pathname)) {
    // 公开路径里只有这两个认证端点单独计数：免会话 + 无限次 = 爆破面与 IdP 放大面
    const authLimit = authLimitFor(pathname);
    if (authLimit && !hit(`${authLimit.key}:${clientIp(request)}`, authLimit.rule)) return tooMany();
    // 文档响应要给真实 Origin（见 isDocumentPath 注释），接口保持 no-referrer
    return apply(NextResponse.next(), isDocumentPath(pathname));
  }

  // 同名 Cookie 可能并存（新旧 Path 各一个），必须按原始头取全部再逐个验签：
  // `cookies.getAll()` 会被 Next 去重成一个，可能恰好拿到旧密钥签的那个。
  const session = await verifyAnySession(
    sessionTokensFromCookieHeader(request.headers.get('cookie'))
  );

  if (!session) {
    if (pathname.startsWith('/api/')) {
      return apply(NextResponse.json({ error: '未登录或会话已过期' }, { status: 401 }));
    }

    // 不能用 `request.nextUrl.clone()`：standalone 下它的 origin 是进程内部监听地址
    // （`localhost:3000` / `0.0.0.0:3000`），经反代后会把浏览器带到内网地址。
    // `portalUrl` 只认 `PUBLIC_BASE_URL`，并自动补部署前缀。
    const loginUrl = portalUrl(request, '/login');
    if (pathname !== '/') loginUrl.searchParams.set('next', pathname);
    return apply(NextResponse.redirect(loginUrl));
  }

  if (pathname.startsWith('/api/portal/')) {
    const rule = session.sub ? LIMITS.portalUser : LIMITS.portalAnon;
    const key = session.sub ? `u:${session.sub}` : `ip:${clientIp(request)}`;
    if (!hit(key, rule)) return tooMany();
  }

  return apply(NextResponse.next(), isDocumentPath(pathname));
}

export const config = {
  // Next 16 起 Proxy 固定运行在 Node.js 运行时，`runtime` 字段已不允许出现——
  // 写它（哪怕值就是 'nodejs'）会让 `next build` 直接失败。
  // 本项目依赖 Node 运行时读进程内环境变量、并使用 pg（见 lib/config/overlay 的短路逻辑），
  // Proxy 的默认运行时正好满足，无需额外声明。
  //
  // 只排除「确定的静态资源」：Next 自己的资源目录与 public/ 下已存在的图片。
  //
  // 这里刻意**不用后缀黑名单**（曾经是 `.*\.(png|svg|txt|...)$`）：那等于宣布
  // 「任何以 .txt 结尾的路径都不做会话检查」，而 `models/[...id]` 这类捕获所有路径的
  // 动态段能匹配到 `/models/x.txt`。当前靠页面 `(portal)/layout.tsx` 与各 route 的
  // `requireSession` 兜住了，但那是「下层记得写」的假设——新增页面忘写就成真洞。
  //
  // public/ 目前只有 `guide/` 下两张接入指南截图；新增静态资源时在这里补一条。
  // 走会话检查会让未登录时拿到跳登录页的 302，浏览器缓存后图就长期是坏的，
  // 所以这些图片必须放行。
  matcher: ['/((?!_next/static|_next/image|favicon.ico|guide/[^/]+\\.(?:png|jpe?g|webp|svg)$).*)'],
};
