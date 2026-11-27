/**
 * 站点内绝对路径拼接。
 *
 * 门户线上挂在 `/tokenhub/portal` 前缀下（Next `basePath`）。框架只会给 `next/link`、
 * `redirect()` 和 `_next` 静态资源自动加前缀，**不会**给 `fetch('/api/...')`
 * 这类手写路径加，所以客户端一律用 `appPath()` 拼。
 *
 * 前缀由 `next.config.ts` 在构建期注入（`.env` 的 `PORTAL_BASE_PATH`），
 * 未配置时是空串，本地开发行为不变。
 */
const BASE_PATH = (
  process.env.NEXT_PUBLIC_PORTAL_BASE_PATH ??
  process.env.PORTAL_BASE_PATH ??
  ''
).replace(/\/+$/, '');

export function appPath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return `${BASE_PATH}${normalized}`;
}
