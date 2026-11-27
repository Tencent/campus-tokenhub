/**
 * OctaFuse HTTP 客户端。
 *
 * 两个通道：
 * - `admin()` 走 Admin（`/api/admin/*`）。实测管理接口**不接受** Bearer key，
 *   必须先 `POST /api/auth/login` 换 httpOnly `admin_session` Cookie，这里在进程内缓存并自动续期。
 * - `publicGet()` 走 Proxy 的公开只读接口（`/catalog/models`、`/health`），无需认证。
 *
 * 约定：错误一律抛 `GatewayError`，消息里**不出现**管理员账号密码与会话 Cookie 值
 * （`OCTAFUSE_ADMIN_*` 是能读写全站用户与密钥的凭证，日志里泄一次就等于全站泄）。
 */

import { getConfig } from '@/lib/config';

export const ADMIN_SESSION_COOKIE = 'admin_session';
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
  /** 测试用：跳过登录，直接指定管理员会话 Cookie */
  adminCookie?: string;
  /** 测试用：强制每次调用都重新登录 */
  forceLogin?: boolean;
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

/** 从 Set-Cookie 里取指定 Cookie 的值（只取 name=value，忽略属性）。 */
export function readSetCookie(response: Response, name: string): string | null {
  const header = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof header.getSetCookie === 'function' ? header.getSetCookie() : [];
  const single = response.headers.get('set-cookie');
  const list = raw.length > 0 ? raw : single ? [single] : [];

  for (const item of list) {
    const first = item.split(';')[0];
    const index = first.indexOf('=');
    if (index <= 0) continue;
    if (first.slice(0, index).trim() !== name) continue;
    return first.slice(index + 1).trim();
  }
  return null;
}

export function createGatewayClient(options: GatewayClientOptions = {}): GatewayClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let cookieHeader: string | null = options.adminCookie
    ? `${ADMIN_SESSION_COOKIE}=${options.adminCookie}`
    : null;

  const send = (url: string, init: RequestInit): Promise<Response> =>
    withTimeout(fetchImpl(url, init), timeoutMs, new URL(url).pathname);

  async function login(): Promise<string> {
    const cfg = getConfig();
    const response = await send(`${cfg.octafuse.adminBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        username: cfg.octafuse.adminUsername,
        password: cfg.octafuse.adminPassword,
      }),
      cache: 'no-store',
    });

    if (!response.ok) {
      // 故意不复述请求体：里面是管理员密码
      throw new GatewayError('网关管理员登录失败', response.status, 'admin_login_failed');
    }

    const value = readSetCookie(response, ADMIN_SESSION_COOKIE);
    if (!value) {
      throw new GatewayError('网关登录未返回会话 Cookie', response.status, 'admin_login_failed');
    }
    return `${ADMIN_SESSION_COOKIE}=${value}`;
  }

  /**
   * 登录单飞（single-flight）。
   *
   * 冷启动时 `getUsageDashboard` 会一次并发 4 个 admin 调用，若每个都各自登录，
   * 网关侧会收到 4~10 次管理员登录（每次都做 BCrypt 校验，可能触发失败计数/锁定）。
   * 并发方共享同一个 Promise，失败后清空以便下次重试。
   */
  let loginInflight: Promise<string> | null = null;

  async function loginOnce(): Promise<string> {
    if (!loginInflight) {
      loginInflight = login().finally(() => {
        loginInflight = null;
      });
    }
    return loginInflight;
  }

  async function ensureCookie(): Promise<string> {
    if (!cookieHeader || options.forceLogin === true) {
      cookieHeader = await loginOnce();
    }
    return cookieHeader;
  }

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
          cookie: await ensureCookie(),
          accept: 'application/json',
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        cache: 'no-store',
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      };

      let response = await send(url, init);

      // 会话过期（网关重启 / Cookie 到期）时重登一次再试，避免把 401 透给学生
      if (response.status === 401) {
        cookieHeader = null;
        init.headers = { ...(init.headers as Record<string, string>), cookie: await ensureCookie() };
        response = await send(url, init);
      }

      return parse<T>(response);
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

/** 进程内单例，复用管理员会话 Cookie。 */
export function getGatewayClient(): GatewayClient {
  if (!defaultClient) defaultClient = createGatewayClient();
  return defaultClient;
}

/** 仅测试用 */
export function resetGatewayClient(): void {
  defaultClient = null;
}
