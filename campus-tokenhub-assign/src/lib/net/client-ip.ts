/**
 * 客户端 IP 提取（限流与审计共用）。
 *
 * **默认不信任任何代理头**：只有部署方显式设置 `TRUST_PROXY_HEADERS=true`，
 * 并且前面的反代用 `$remote_addr` **覆写**（而不是追加）`X-Forwarded-For` 时，
 * 才取 XFF 最左段作为客户端 IP。仓库自带的 nginx / compose 已显式置 `true`。
 *
 * 为什么默认关闭：学校常见的自建反代用 `$proxy_add_x_forwarded_for`（保留并追加），
 * 或者直接把 3000 端口暴露出去。这两种情况下客户端自带的 XFF 就是最左值，
 * 换一个伪造值就能换一个限流桶——密码登录失败锁定、管理台账密登录限流与审计 IP
 * 溯源会同时失效。
 *
 * 未开启时的退化行为：所有请求落到同一个桶（`fallback`），既不可伪造，也不会更松。
 * 启动日志会打印当前模式，见 `src/instrumentation.ts`。
 */

export const TRUST_PROXY_HEADERS_ENV = 'TRUST_PROXY_HEADERS';

type HeaderReader = { get(name: string): string | null };

/** 只有 `true` / `1` 才算开启；未设置、拼错、`false`、`0` 一律按关闭处理 */
export function trustProxyHeaders(raw: string | undefined = process.env[TRUST_PROXY_HEADERS_ENV]): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

export function clientIpFromHeaders(headers: HeaderReader, fallback = 'unknown'): string {
  if (!trustProxyHeaders()) return fallback;

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  return real || fallback;
}
