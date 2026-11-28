/**
 * 端到端测试的最小运行时：零依赖，只用 Node 内置 fetch（Node 18+ / 本机 v25 均可）。
 *
 * 存在的理由：网关与门户都是"部署之后才知道对不对"的东西（nginx 前缀、Cookie
 * Path、两站会话互认、网关 admin 凭据），单测覆盖不到。这里直接在真实 HTTP 上跑，
 * 因此同一份用例既能打本地 compose，也能打线上域名。
 *
 * 约定：
 * - 用例只描述"请求什么、期望什么"，日志/汇总/退出码由 runSuite 统一处理；
 * - 断言失败抛普通 Error，主动跳过抛 SkipError；
 * - 任何请求失败都带上完整 URL，避免只看到 "fetch failed"。
 */

import process from 'node:process';

export const SESSION_COOKIE = 'portal_session';

function trimSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function joinUrl(base, path) {
  if (!path) return trimSlash(base);
  if (/^https?:\/\//i.test(path)) return path;
  return `${trimSlash(base)}${path.startsWith('/') ? path : `/${path}`}`;
}

/** `--flag value` / `--flag` / `--flag=value` 三种写法都认 */
export function parseArgs(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [rawKey, inlineValue] = arg.slice(2).split('=');
    if (inlineValue !== undefined) {
      options[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[rawKey] = true;
      continue;
    }
    options[rawKey] = next;
    index += 1;
  }
  return options;
}

function pick(options, flag, envName, fallback) {
  const fromFlag = options[flag];
  const fromEnv = process.env[envName];
  const value = (typeof fromFlag === 'string' && fromFlag) || fromEnv || fallback;
  return String(value ?? '');
}

/**
 * 目标地址解析。
 *
 * 默认按项目根 docker-compose 的形态：单端口 8088 + 两站前缀。
 * 线上或多机部署时用 --origin 指域名，或分别用 --portal / --member / --gateway 覆盖。
 */
export function resolveTargets(options = {}) {
  const origin = trimSlash(pick(options, 'origin', 'E2E_ORIGIN', 'http://127.0.0.1:8088'));
  const portal = trimSlash(pick(options, 'portal', 'E2E_PORTAL_BASE', `${origin}/tokenhub/portal`));
  // 门户挂在 /portal 时，网关前缀就是它的上级目录
  const gatewayFallback = /\/portal$/.test(portal) ? portal.replace(/\/portal$/, '') : `${origin}/tokenhub`;
  const gateway = trimSlash(pick(options, 'gateway', 'E2E_GATEWAY_BASE', gatewayFallback));
  const member = trimSlash(pick(options, 'member', 'E2E_MEMBER_BASE', `${origin}/tokenhub/member`));
  const rawCookie = pick(options, 'cookie', 'E2E_SESSION_COOKIE', '').trim();
  const cookie = rawCookie && !rawCookie.includes('=') ? `${SESSION_COOKIE}=${rawCookie}` : rawCookie;
  const timeout = Number(pick(options, 'timeout', 'E2E_TIMEOUT_MS', '15000')) || 15_000;

  return { origin, portal, member, gateway, cookie, timeout, verbose: Boolean(options.verbose) };
}

export class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'SkipError';
  }
}

/** 主动跳过（前置条件不满足，而不是功能坏了） */
export function skip(reason) {
  throw new SkipError(reason);
}

/** 断言；失败信息要能让运维直接判断该看哪里 */
export function need(condition, message, hint) {
  if (condition) return;
  const error = new Error(message);
  if (hint) error.hint = hint;
  throw error;
}

/**
 * 发一次请求并归一化结果。
 *
 * redirect 固定 manual：3xx 本身就是被测行为（未登录跳登录页、登录成功 303），
 * 跟随跳转会把这些状态吃掉。同源校验要求 POST/PUT/DELETE 带 Origin，这里按 URL 自动补。
 */
export async function request(ctx, url, options = {}) {
  const {
    method = 'GET',
    body,
    form,
    cookie,
    headers = {},
    redirect = 'manual',
  } = options;

  const finalHeaders = {
    accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    'user-agent': 'campus-tokenhub-e2e/1.0',
    ...headers,
  };

  const usedCookie = cookie === undefined ? ctx.cookie : cookie;
  if (usedCookie) finalHeaders.cookie = usedCookie;
  if (!['GET', 'HEAD'].includes(method) && !finalHeaders.origin) {
    finalHeaders.origin = new URL(url).origin;
  }

  let payload;
  if (form) {
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    finalHeaders['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      redirect,
      signal: AbortSignal.timeout(ctx.timeout),
    });
  } catch (error) {
    const reason = error?.cause?.code ?? error?.cause?.message ?? error?.message ?? String(error);
    const failure = new Error(`请求失败 ${method} ${url}（${reason}）`);
    failure.hint =
      '目标不可达：确认服务已启动、地址前缀正确（本地 compose 默认 http://127.0.0.1:8088）';
    throw failure;
  }

  const text = await response.text();
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    url,
    method,
    status: response.status,
    headers: response.headers,
    contentType: response.headers.get('content-type') ?? '',
    location: response.headers.get('location') ?? '',
    text,
    json,
    ms: Date.now() - startedAt,
  };
}

/** 从 Set-Cookie 里取门户会话（只能拿到值，取不到就是部署把 Cookie 写坏了） */
export function sessionCookieFrom(res) {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const raw = lines.length > 0 ? lines : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const match = new RegExp(`(?:^|[,;]\\s*)${SESSION_COOKIE}=([^;,\\s]+)`).exec(line);
    if (match) return `${SESSION_COOKIE}=${match[1]}`;
  }
  return '';
}

/** 常见状态码的排障提示：写进失败信息，省一轮来回 */
export function hintForStatus(status, scope = '门户') {
  if (status === 404) return `${scope}返回 404：多数是部署前缀不对（basePath / nginx 转发），检查 E2E_*_BASE`;
  if (status === 502) return `${scope}返回 502：反向代理到后端不通，先看对应容器是否 healthy`;
  if (status === 503) return `${scope}返回 503：服务在但依赖未就绪（配置/数据库/网关），查服务日志`;
  if (status >= 500) return `${scope}返回 ${status}：服务端异常，按响应里的 x-request-id 查日志`;
  if (status === 401) return `${scope}返回 401：会话 Cookie 无效或已过期（重新登录后复制新 Cookie）`;
  if (status === 403) return `${scope}返回 403：当前身份不是全局管理员，或 Origin 校验未通过`;
  if (status === 429) return `${scope}返回 429：触发了进程内限流，稍等 60 秒再跑`;
  return '';
}

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code) => (text) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = paint('2');
const green = paint('32');
const red = paint('31');
const yellow = paint('33');
const bold = paint('1');

function pad(text, width) {
  // 中文按 2 个字符宽度估算，保证列对齐
  const visual = [...text].reduce((total, char) => total + (/[\u4e00-\u9fa5]/.test(char) ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(0, width - visual));
}

export function createContext(targets) {
  const ctx = {
    ...targets,
    state: {},
    portal: (path) => joinUrl(targets.portal, path),
    member: (path) => joinUrl(targets.member, path),
    gateway: (path) => joinUrl(targets.gateway, path),
    http: (url, options) => request(ctx, url, options),
  };
  return ctx;
}

/**
 * 跑一组用例，打印结果并返回是否全绿。
 *
 * 一个用例失败不影响后续用例：端到端报告的价值在于"一次跑完知道坏了几处"。
 */
export async function runSuite({ title, description, targets, cases }) {
  const ctx = createContext(targets);

  console.log('');
  console.log(bold(title));
  if (description) console.log(dim(description));
  console.log(dim(`门户 ${targets.portal}`));
  console.log(dim(`成员站 ${targets.member}`));
  console.log(dim(`网关 ${targets.gateway}`));
  if (!targets.cookie) console.log(dim('会话 Cookie：未提供（已登录检查将跳过）'));
  console.log('');

  const results = [];
  for (const testCase of cases) {
    const label = `${testCase.id} ${testCase.name}`;
    try {
      if (testCase.enabled && !testCase.enabled(ctx)) {
        results.push({ status: 'skip', id: testCase.id, name: testCase.name, detail: testCase.skipReason ?? '前置条件不满足' });
        console.log(`${yellow('⚠')}  ${pad(label, 46)} ${dim(`跳过：${testCase.skipReason ?? '前置条件不满足'}`)}`);
        continue;
      }
      const detail = await testCase.run(ctx);
      results.push({ status: 'pass', id: testCase.id, name: testCase.name, detail });
      console.log(`${green('✅')} ${pad(label, 46)} ${detail ? dim(String(detail)) : ''}`);
    } catch (error) {
      if (error instanceof SkipError) {
        results.push({ status: 'skip', id: testCase.id, name: testCase.name, detail: error.message });
        console.log(`${yellow('⚠')}  ${pad(label, 46)} ${dim(`跳过：${error.message}`)}`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      results.push({ status: 'fail', id: testCase.id, name: testCase.name, detail: message });
      console.log(`${red('❌')} ${pad(label, 46)} ${red(message)}`);
      if (error?.hint) console.log(`   ${dim('→')} ${dim(error.hint)}`);
    }
  }

  const passed = results.filter((item) => item.status === 'pass').length;
  const failed = results.filter((item) => item.status === 'fail').length;
  const skipped = results.filter((item) => item.status === 'skip').length;

  console.log('');
  console.log(
    `${failed === 0 ? green('通过') : red('存在失败')}：通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}` +
      (failed > 0 ? red('  ← 见上方失败项与提示') : '')
  );
  if (skipped > 0) {
    console.log(dim('跳过的项多为"未提供会话"或"环境未配置"，不代表功能正常。'));
  }
  console.log('');

  return { ok: failed === 0, results };
}
