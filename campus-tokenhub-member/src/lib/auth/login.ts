/**
 * 登录后的公共链路：先开户（可失败），再签发会话。
 *
 * 标准 OAuth2 与 CAS 都走这里，切换 provider 不影响后续逻辑。
 * 开户失败不阻断登录（design D5）：`octafuse_user_id` 留空，算力账户页引导「重试开通」。
 */

import { appPath } from '@/lib/paths';
import { signSession } from './session';
import { claimFirstAdminOnLogin, syncAdminRolesOnLogin, withAdminClaim } from './admin';
import { getConfig } from '@/lib/config';
import type { Identity } from './providers/types';

export async function establishSession(identity: Identity): Promise<string> {
  // 全新部署（管理员名单为空）时，把首个合法登录者认领为管理员。
  // 只在这里做：这是成员站唯一的会话签发点，副作用仅此一次且带审计；
  // 放在 `resolvePortalAdmin` 那种读判定里会让任何一次探测都产生写操作。
  await claimFirstAdminOnLogin(identity.sub);

  // 角色命中「自动同步为管理员的角色」时补进名单（只增不删；失败不阻断登录）
  await syncAdminRolesOnLogin(identity);

  // 管理员声明在这里统一打标；非管理员不带该 claim。
  // 注意顺序：先认领再判定，否则本次登录拿不到自己刚认领的管理员身份。
  return signSession(
    await withAdminClaim({
      sub: identity.sub,
      email: identity.email,
      name: identity.name,
      schoolName: identity.schoolName,
    })
  );
}

/**
 * 登录后跳转目标只允许站内相对路径，防开放重定向。
 * `//evil.com`、`https://evil.com`、反斜杠变形统一回落到 `fallback`。
 *
 * `fallback` 默认 `/members`（成员站首页）；显式合法的 `next` 永远优先。
 */
export function sanitizeNextPath(
  raw: string | null | undefined,
  fallback = '/members'
): string {
  if (!raw) return fallback;
  const value = raw.trim();
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;
  // 去掉换行等控制字符，避免响应头注入
  if (/[\u0000-\u001f]/.test(value)) return fallback;
  return value;
}

/**
 * 已有会话的人访问登录页时的落点。
 *
 * 与登录成功后同一套 `next` 语义，只额外挡掉两类会出问题的目标：
 * - `/login` 自身：跳回去又被「已登录」弹走，形成自环；
 * - `/api/...`：这些是给表单 / fetch 用的接口，直接把页面导航过去只会拿到 405 / 401。
 */
export function loginReuseTarget(
  raw: string | null | undefined,
  fallback: string
): string {
  const target = sanitizeNextPath(raw, fallback);
  // 只取路径部分比较：`/login?next=...`、`/login#x` 同样是登录页
  const pathname = target.split(/[?#]/, 1)[0];
  if (pathname === '/login' || pathname.startsWith('/login/')) return fallback;
  if (pathname === '/api' || pathname.startsWith('/api/')) return fallback;
  return target;
}

/**
 * 管理台深链接的净化规则（与 `sanitizeNextPath` 同一套边界，默认值不同）。
 *
 * 入参是**已解码**的站内相对路径（调用方负责 URL 解码一次，避免二次解码把
 * `%2520` 这类内容悄悄改写成空格）。只允许管理台自己域名下的路径，
 * 因此结果永远以单个 `/` 开头。
 */
export function sanitizeAdminNext(raw: string | null | undefined): string {
  if (!raw) return '/';
  const value = raw.trim();
  if (!value.startsWith('/')) return '/';
  if (value.startsWith('//') || value.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(value)) return '/';
  return value;
}

/**
 * 管理台回跳地址。
 *
 * 基址只认配置项 `ADMIN_PUBLIC_BASE_URL`：留空时返回 null 由调用方报错，
 * **不**回落到任何容器内网地址（浏览器打不开）。
 */
export function adminReturnUrl(raw: string | null | undefined): string | null {
  const base = getConfig().portal.adminPublicBaseUrl;
  if (!base) return null;
  let target = sanitizeAdminNext(raw);
  // 兜底：即使上游把带公网前缀的路径塞进 next（历史 URL / 旧版前端），
  // 也不能拼出 /tokenhub/admin/tokenhub/admin/... 这种被 nginx 剥两次后 404 的地址。
  const basePath = new URL(base).pathname.replace(/\/+$/, '');
  if (basePath && (target === basePath || target.startsWith(`${basePath}/`))) {
    target = target.slice(basePath.length) || '/';
  }
  return `${base.replace(/\/+$/, '')}${target}`;
}

/**
 * 管理台发起的登录目标。`dest=admin` 时 `next` 表示管理台内的深链接，
 * 不再是门户站内路径，因此单独解析，避免两类语义挤在同一个字段。
 */
export type AdminLoginTarget = { dest: 'admin'; adminNext: string };

export function readAdminLoginTarget(params: {
  dest?: string | null;
  next?: string | null;
}): AdminLoginTarget | null {
  if ((params.dest ?? '').trim() !== 'admin') return null;
  return { dest: 'admin', adminNext: sanitizeAdminNext(params.next) };
}

/**
 * 站内绝对 URL。
 *
 * 配了 `PUBLIC_BASE_URL` 就只认它；`Host` / `X-Forwarded-Host` 都能被请求方自带，
 * 用它们拼 Location 等于送一个开放重定向（实测 Host: evil.example 会 302 到站外）。
 * 未配置时（仅本地开发）退回请求自身的 Host，且不再信任 `X-Forwarded-Host`。
 */
export function portalUrl(request: Request, path: string): URL {
  const { portal } = getConfig();
  // `PUBLIC_BASE_URL` 已含部署前缀（如 `https://host/tokenhub/portal`），
  // 而 `new URL('/login', base)` 会把路径里的前缀丢掉，所以先补前缀再拼。
  const target = appPath(path);
  if (portal.publicBaseUrl) return new URL(target, portal.publicBaseUrl);

  const host = request.headers.get('host');
  if (!host) return new URL(target, request.url);
  return new URL(target, `${new URL(request.url).protocol}//${host}`);
}

/**
 * 登录回调路径。
 *
 * 门户自己的回调路由，路径固定，不开放配置：学校 IdP 那边登记的白名单必须与这里一致，
 * 让它在设置页可改只会制造「保存后登录 404 / redirect_uri 不匹配」。
 */
export const AUTH_CALLBACK_PATH = '/api/auth/callback';

/** 当前部署下的登录回调地址：路径写死，只随部署域名（`PUBLIC_BASE_URL`）变化 */
export function authCallbackUrl(request: Request): string {
  return portalUrl(request, AUTH_CALLBACK_PATH).toString();
}
