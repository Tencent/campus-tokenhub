/**
 * 出站地址白名单：只允许访问公网 http(s)。
 *
 * 用途是「管理员填写地址 → 服务端发起请求」的探测接口（初始化 / 设置页）。
 * 这类接口天然是 SSRF 入口：不加限制就能拿容器身份去打云元数据、内网管理端口。
 *
 * 限制：
 * - 只允许 http / https（挡 file: / data: / gopher:）；
 * - 拒绝回环、私网、链路本地、CGNAT、组播/保留段；
 * - 域名先做 DNS 解析，任一解析结果落在上面这些网段就拒绝；
 * - 调用方必须同时用 `redirect: 'manual'`，否则 30x 可以绕过首跳校验。
 *
 * 说明：这里挡不住 DNS rebinding（解析时公网、请求时内网），要彻底解决需要
 * 固定解析结果后按 IP 连接；对「管理员手工填地址」的场景先做到这一步。
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export type UrlGuardResult = { ok: true; url: URL } | { ok: false; message: string };

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const value = ipv4ToInt(ip);
  const network = ipv4ToInt(base);
  if (value === null || network === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (network & mask);
}

const BLOCKED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** 回环 / 私网 / 链路本地 / 未指定地址 */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return BLOCKED_V4.some(([base, bits]) => inCidr4(ip, base, bits));
  if (family === 6) {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1') return true;
    // IPv4-mapped（::ffff:10.0.0.1）
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isBlockedAddress(mapped[1]);
    // fc00::/7（ULA）、fe80::/10（链路本地）、ff00::/8（组播）
    return /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || /^ff/.test(value);
  }
  return false;
}

/** 校验一个用户填写的地址能否由服务端发起请求。 */
export async function assertPublicHttpUrl(raw: string, label: string): Promise<UrlGuardResult> {  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${label}不是合法地址，请填写完整的 http(s) 地址` };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: `${label}必须是 http(s) 地址` };
  }
  if (url.username || url.password) {
    return { ok: false, message: `${label}不能包含用户名密码` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, message: `${label}缺少主机名` };

  if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) {
    return { ok: false, message: `${label}不能指向内网地址` };
  }

  if (isIP(host)) {
    return isBlockedAddress(host)
      ? { ok: false, message: `${label}不能指向内网地址` }
      : { ok: true, url };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return { ok: false, message: `${label}的域名无法解析，请检查地址是否正确` };
  }
  if (addresses.length === 0) {
    return { ok: false, message: `${label}的域名无法解析，请检查地址是否正确` };
  }
  if (addresses.some((item) => isBlockedAddress(item.address))) {
    return { ok: false, message: `${label}不能指向内网地址` };
  }

  return { ok: true, url };
}

// ------------------------------------------------------------ 出站请求的通用守卫

/**
 * 云厂商元数据地址：拿到它就等于拿到实例凭证，单独点名（`100.100.100.200` 是腾讯云）。
 * `169.254.169.254` 已被链路本地段覆盖，这里列出来只是让规则自解释。
 */
const METADATA_IPS = new Set(['100.100.100.200', '169.254.169.254']);

/**
 * 回环 / 链路本地 / 未指定地址 —— 出站请求打到这些地方，**唯一合理用途**是打本机或云元数据。
 *
 * 与 `isBlockedAddress` 的差别：这里**不拦私网段**（10/8、172.16/12、192.168/16）。
 * 学校的 SSO、内网网关本来就常在这些段里，用 `assertPublicHttpUrl` 那一套会把正常登录拦死；
 * 而攻击者真正想要的是「打本机端口」和「读实例凭证」，这两类都被本函数挡住。
 */
export function isLocalOnlyAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return (
      inCidr4(ip, '127.0.0.0', 8) ||
      inCidr4(ip, '169.254.0.0', 16) ||
      inCidr4(ip, '0.0.0.0', 8) ||
      METADATA_IPS.has(ip)
    );
  }
  if (family === 6) {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
    if (mapped) return isLocalOnlyAddress(mapped[1]);
    // fe80::/10 链路本地
    return /^fe[89ab]/.test(value);
  }
  return false;
}

export type OutboundGuardOptions = {
  /**
   * 是否强制拦截。不传时按 `NODE_ENV`：生产强制，其它环境只告警——
   * 本地调试经常把 IdP / 网关跑在 `127.0.0.1` 上，硬拦会让 `npm run dev` 完全登不进去。
   */
  enforce?: boolean;
};

/**
 * 逃生开关：`OUTBOUND_GUARD=off` 时生产也退化成只告警。
 *
 * 为什么需要：少数部署会把 SSO 端点放在本机（同机 nginx 反代 `/cas`）。
 * 没有开关的话，升级后表现为「所有人都登不进去、日志里只有一句端点被拦」，只能改代码重发版；
 * 有这个开关就能先 `OUTBOUND_GUARD=off` 起来，再从容把 IdP 换成内网 IP / 域名。
 * 默认仍然是强制拦截——放开必须是显式行为，且会持续打告警日志。
 */
function outboundGuardDisabled(): boolean {
  return (process.env.OUTBOUND_GUARD ?? '').trim().toLowerCase() === 'off';
}

/**
 * 服务端发起出站请求前的地址校验（用于 SSO 端点、上游探测地址这类**配置来源**的 URL）。
 *
 * 与 `assertPublicHttpUrl` 是两个场景：那个用于「管理员手填、要求必须是公网」的探测；
 * 这个用于「业务上允许内网、但绝不能打本机与云元数据」的出站请求。
 *
 * 说明：仍然挡不住 DNS rebinding（解析时公网、连接时内网），要彻底解决需要固定解析结果后
 * 按 IP 连接；对「配置由管理员填写」的场景，挡掉回环与元数据已经把可利用价值降到很低。
 */
export async function assertOutboundAllowed(
  raw: string,
  label: string,
  options: OutboundGuardOptions = {}
): Promise<UrlGuardResult> {
  const enforce =
    options.enforce ?? (!outboundGuardDisabled() && process.env.NODE_ENV === 'production');

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `${label}不是合法地址` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: `${label}必须是 http(s) 地址` };
  }

  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return { ok: false, message: `${label}缺少主机名` };

  const blocked = (reason: string): UrlGuardResult => {
    if (!enforce) {
      // 开发环境放行但要留痕：真出问题时有据可查，也不至于把本地调试锁死
      console.warn(`[url-guard] ${label}${reason}（非生产环境仅告警）：${host}`);
      return { ok: true, url };
    }
    return { ok: false, message: `${label}${reason}` };
  };

  if (
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host === 'metadata.tencentyun.com'
  ) {
    return blocked('不能指向本机或云元数据地址');
  }

  if (isIP(host)) {
    return isLocalOnlyAddress(host) ? blocked('不能指向本机或云元数据地址') : { ok: true, url };
  }

  // 非强制模式不再做 DNS 解析：开发/测试环境里做一次真实解析既慢又不可靠，
  // 而 IP 字面量与主机名这两种最直接的写法上面已经拦掉了。
  if (!enforce) return { ok: true, url };

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    // 解析失败交给调用方：它要发请求时自然会失败并给出可读错误，这里不额外拦
    return { ok: true, url };
  }
  if (addresses.some((item) => isLocalOnlyAddress(item.address))) {
    return blocked('解析到了本机或云元数据地址');
  }

  return { ok: true, url };
}
