/**
 * OctaFuse HTTP 客户端。
 *
 * 两个通道：
 * - `admin()` 走 Admin（`/api/admin/*`），用网关后台「系统集成 → 集成密钥」签发的
 *   具名 Admin API Key：`Authorization: Bearer <key>`。门户不再持有网关管理员账号密码，
 *   也不再走 `/api/auth/login` 换 `admin_session` Cookie。
 * - `publicGet()` 走 Proxy 的公开只读接口（`/catalog/models`、`/health`），无需认证。
 *
 * 约定：错误一律抛 `GatewayError`，消息里**不出现**集成密钥明文
 * （它能读写全站用户与密钥，日志里泄一次就等于全站泄）。
 */

import { getConfig } from '@/lib/config';

const DEFAULT_TIMEOUT_MS = 5000;

export class GatewayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 0, code = 'gateway_error') {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
  }
}

export type GatewayQuery = Record<string, string | number | boolean | undefined>;

export type GatewayRequest = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: GatewayQuery;
  body?: unknown;
};

export type GatewayClient = {
  admin<T>(path: string, request?: GatewayRequest): Promise<T>;
  publicGet<T>(path: string): Promise<T>;
};

export type GatewayClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function buildUrl(base: string, path: string, query?: GatewayQuery): string {
  const url = new URL(`${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GatewayError(`网关请求超时（${label}）`, 0, 'timeout'));
    }, timeoutMs);
    // 不阻塞进程退出（Next 的 route handler 在长连接下容易悬挂）
    if (typeof timer === 'object' && timer && 'unref' in timer) timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function pickMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail'] as const) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return `网关返回 HTTP ${status}`;
}

function pickErrorCode(payload: unknown): string | undefined {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    if (typeof record.code === 'string') return record.code;
    if (typeof record.error_code === 'string') return record.error_code;
  }
  return undefined;
}

export function createGatewayClient(options: GatewayClientOptions = {}): GatewayClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const send = (url: string, init: RequestInit): Promise<Response> =>
    withTimeout(fetchImpl(url, init), timeoutMs, new URL(url).pathname);

  async function parse<T>(response: Response): Promise<T> {
    const payload = await readJson(response);
    if (!response.ok) {
      throw new GatewayError(pickMessage(payload, response.status), response.status, pickErrorCode(payload) ?? 'gateway_http_error');
    }
    return payload as T;
  }

  return {
    async admin<T>(path: string, request: GatewayRequest = {}): Promise<T> {
      const cfg = getConfig();
      const url = buildUrl(cfg.octafuse.adminBase, path, request.query);
      const init: RequestInit = {
        method: request.method ?? 'GET',
        headers: {
          authorization: `Bearer ${cfg.octafuse.adminApiKey}`,
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        cache: 'no-store',
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      };

      // 401/403 不再重登：Bearer Key 无效或权限不足只能由运维在网关后台轮换/授权，
      // 重试只会放大失败。状态码与 required_permission 原样交给上层排查。
      return parse<T>(await send(url, init));
    },

    async publicGet<T>(path: string): Promise<T> {
      const cfg = getConfig();
      const response = await send(buildUrl(cfg.octafuse.proxyBase, path), {
        method: 'GET',
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      return parse<T>(response);
    },
  };
}

let defaultClient: GatewayClient | null = null;

/** 进程内单例（无状态，仅复用 fetch 配置）。 */
export function getGatewayClient(): GatewayClient {
  if (!defaultClient) defaultClient = createGatewayClient();
  return defaultClient;
}

/** 仅测试用 */
export function resetGatewayClient(): void {
  defaultClient = null;
}
