/**
 * 客户端 IP 提取（限流与审计共用）。
 *
 * **前提：反向代理必须覆写 `X-Forwarded-For`，而不是追加。**
 * 仓库自带 `deploy/nginx.conf.template` 已改成「用 $remote_addr 覆写」，
 * 并只在 `set_real_ip_from` 指定的内网来源（CLB / VPC）上信任上游 XFF。
 *
 * 如果反代是追加（`$proxy_add_x_forwarded_for`），最左值就是客户端自带的，
 * 换一个伪造值就能换一个限流桶，审计里的 IP 也失去溯源价值。
 */

type HeaderReader = { get(name: string): string | null };

export function clientIpFromHeaders(headers: HeaderReader, fallback = 'unknown'): string {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = headers.get('x-real-ip')?.trim();
  return real || fallback;
}
