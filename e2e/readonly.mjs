#!/usr/bin/env node
/**
 * 端到端用例（一）：只读验收。线上部署后可直接执行。
 *
 * 只发 GET 请求，不登录、不写入、不建会话，因此对线上数据零影响；
 * 带上已有会话 Cookie 时会额外核对"已登录能读到什么"（仍然是纯读）。
 *
 * 用法：
 *   # 本地 compose（默认指向 http://127.0.0.1:8088 的两站前缀）
 *   node e2e/readonly.mjs
 *
 *   # 线上：只跑未登录检查（不需要任何凭据）
 *   node e2e/readonly.mjs --origin https://ai.example.edu
 *
 *   # 线上：附带已登录读检查（Cookie 从浏览器开发者工具复制，含 portal_session=...）
 *   node e2e/readonly.mjs --origin https://ai.example.edu --cookie "portal_session=xxx"
 *
 *   # 单站部署/自定义前缀
 *   node e2e/readonly.mjs --portal https://host/tokenhub/portal --member https://host/tokenhub/member --gateway https://host/tokenhub
 *
 * 也支持环境变量：E2E_ORIGIN / E2E_PORTAL_BASE / E2E_MEMBER_BASE / E2E_GATEWAY_BASE /
 * E2E_SESSION_COOKIE / E2E_TIMEOUT_MS。
 *
 * 退出码：0 = 全部通过（跳过项不算失败），1 = 有失败项。
 */

import process from 'node:process';
import {
  hintForStatus,
  need,
  parseArgs,
  resolveTargets,
  runSuite,
  skip,
} from './lib/harness.mjs';

const targets = resolveTargets(parseArgs());

/** 已登录检查：没有 Cookie 就跳过，而不是判失败 */
function requireCookie(ctx) {
  if (!ctx.cookie) skip('未提供会话（--cookie 或 E2E_SESSION_COOKIE）');
}

/** 管理口径的读接口：学生身份会话会 403，这属于"没权限"而不是"功能坏了" */
function skipIfNotAdmin(res) {
  if (res.status === 403) skip('当前会话不是全局管理员，无法核对管理口径的读接口');
}

function assertJson(res, label) {
  need(res.json !== null, `${label} 返回的不是 JSON（HTTP ${res.status}）`, hintForStatus(res.status, label));
  return res.json;
}

const cases = [
  {
    id: 'R1',
    name: '门户健康检查',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/api/health'));
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '健康检查');
      need(body.status === 'ok', `status 应为 ok，实际 ${JSON.stringify(body.status)}`);
      need(
        body.gateway === true,
        '门户活着但网关不可达（gateway:false）：模型目录读不到，学生领 Key 后也调不通',
        '查 gateway-proxy / gateway-admin 是否 healthy，门户的 OCTAFUSE_ADMIN_BASE 是否指向它们'
      );
      return 'status=ok gateway=true';
    },
  },
  {
    id: 'R2',
    name: '网关拒绝未授权调用',
    run: async (ctx) => {
      const res = await ctx.http(ctx.gateway('/v1/models'), { headers: { accept: 'application/json' } });
      if (res.status === 404) {
        throw Object.assign(new Error(`网关前缀返回 404：${res.url}`), {
          hint: 'E2E_GATEWAY_BASE 应指向 /tokenhub（剥离 /v1 之前的前缀）；单站部署时用 --gateway 指定',
        });
      }
      need(
        res.status === 401,
        `未带 Key 调 /v1/models 应 401，实际 ${res.status}`,
        hintForStatus(res.status, '网关')
      );
      need(/api key/i.test(res.text), `401 响应体不含 "API key" 说明，实际：${res.text.slice(0, 120)}`);
      return '401 Missing or invalid API key';
    },
  },
  {
    id: 'R3',
    name: '未登录访问页面 → 跳登录页',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/overview'), { cookie: '' });
      need(res.status >= 300 && res.status < 400, `期望 3xx 跳转，实际 ${res.status}`, hintForStatus(res.status));
      need(
        res.location.includes('/login'),
        `跳转目标不含 /login：${res.location || '（无 Location）'}`,
        '检查 PUBLIC_BASE_URL 与 PORTAL_BASE_PATH 是否与实际访问地址一致'
      );
      return `${res.status} → ${res.location.replace(/^https?:\/\/[^/]+/, '')}`;
    },
  },
  {
    id: 'R4',
    name: '未登录调用接口 → 401',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/api/portal/keys'), { cookie: '' });
      need(res.status === 401, `期望 401，实际 ${res.status}`, hintForStatus(res.status));
      return '401';
    },
  },
  {
    id: 'R5',
    name: '登录页可访问',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/login'), { cookie: '' });
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      need(/text\/html/i.test(res.contentType), `content-type 不是 HTML：${res.contentType}`);
      need(res.text.includes('登录'), '页面里找不到"登录"字样，可能渲染失败或部署了错误的构建产物');
      return '200 html';
    },
  },
  {
    id: 'R6',
    name: '安全响应头生效',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/login'), { cookie: '' });
      const frame = res.headers.get('x-frame-options') ?? '';
      const nosniff = res.headers.get('x-content-type-options') ?? '';
      need(/DENY/i.test(frame), `x-frame-options 期望 DENY，实际 "${frame}"`, '中间件没生效或被反代剥离');
      need(/nosniff/i.test(nosniff), `x-content-type-options 期望 nosniff，实际 "${nosniff}"`);
      const csp = res.headers.get('content-security-policy') ?? '';
      if (csp) need(csp.includes("frame-ancestors 'none'"), 'CSP 存在但缺少 frame-ancestors \'none\'');
      return csp ? 'deny + nosniff + CSP' : 'deny + nosniff（开发模式无 CSP）';
    },
  },
  {
    id: 'R7',
    name: 'Logo 接口返回正常（200 或未配置 404）',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/api/portal/branding/logo'), { cookie: '' });
      need(res.status < 500, `期望 200 或 404，实际 ${res.status}`, hintForStatus(res.status));
      if (res.status === 200) {
        need(/^image\//i.test(res.contentType), `content-type 不是图片：${res.contentType}`);
        return '200 image';
      }
      need(res.json?.code === 'logo_absent', `404 但 code 不是 logo_absent：${res.text.slice(0, 120)}`);
      return '404 logo_absent（尚未配置 Logo）';
    },
  },
  {
    id: 'R8',
    name: '已登录：读取运行期配置',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/settings'));
      skipIfNotAdmin(res);
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '设置接口');
      need(body.values && typeof body.values === 'object', '响应缺少 values 对象');
      need(body.effective && typeof body.effective === 'object', '响应缺少 effective 对象（页面回显依赖它）');
      return `values ${Object.keys(body.values).length} 项 / effective ${Object.keys(body.effective).length} 项`;
    },
  },
  {
    id: 'R9',
    name: '已登录：配置接口不泄露敏感值',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/settings'));
      skipIfNotAdmin(res);
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '设置接口');
      const secrets = body.secrets ?? {};
      const plaintextLeaks = Object.keys(secrets).filter((key) => typeof body.values?.[key] === 'string' && body.values[key]);
      need(
        plaintextLeaks.length === 0,
        `敏感项明文出现在 values 里：${plaintextLeaks.join(', ')}`,
        '这是安全问题，必须让敏感字段只回显 hint/configured'
      );
      for (const [key, state] of Object.entries(secrets)) {
        need(typeof state?.configured === 'boolean', `secrets.${key} 缺少 configured 字段`);
        need(typeof state?.hint === 'string', `secrets.${key} 缺少 hint 字段`);
      }
      return `${Object.keys(secrets).length} 个敏感项均已脱敏`;
    },
  },
  {
    id: 'R10',
    name: '已登录：管理员候选名单（管理口径）',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/admins/candidates'));
      skipIfNotAdmin(res);
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '管理员候选名单');
      need(Array.isArray(body.candidates), '响应缺少 candidates 数组');
      const page = await ctx.http(ctx.portal('/settings/admins'));
      need(page.status === 200, `管理员页面期望 200，实际 ${page.status}`, hintForStatus(page.status));
      return `${body.candidates.length} 位候选 / 页面 200`;
    },
  },
  {
    id: 'R11',
    name: '已登录：读取运营活动配置',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/activities/config'));
      skipIfNotAdmin(res);
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '活动配置');
      need(Array.isArray(body.activities), '响应缺少 activities 数组');
      return `${body.activities.length} 个活动`;
    },
  },
  {
    id: 'R12',
    name: '已登录：读取密钥列表且明文不外泄',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/keys'));
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status));
      const body = assertJson(res, '密钥列表');
      need(typeof body.ready === 'boolean', '响应缺少 ready 字段');
      need(Array.isArray(body.keys), '响应缺少 keys 数组');
      for (const key of body.keys) {
        need(
          typeof key.key === 'string' && key.key.includes('••••'),
          `密钥明文出现在了列表里（${key.id ?? '未知 id'}）`,
          '列表必须只给掩码；明文只在 /api/portal/key 单次读取'
        );
      }
      return body.ready ? `${body.keys.length} 把密钥` : '未开户（ready=false）';
    },
  },
  {
    id: 'R13',
    name: '已登录：读取当前密钥（未开通也算正常）',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.portal('/api/portal/key'));
      need(
        [200, 404, 409].includes(res.status),
        `期望 200/404(no_key)/409(not_provisioned)，实际 ${res.status}`,
        hintForStatus(res.status)
      );
      if (res.status === 200) {
        const body = assertJson(res, '当前密钥');
        need(typeof body.key === 'string' && body.key.length > 8, '响应缺少 key 明文');
        return '200 有可用密钥';
      }
      return `${res.status} ${res.json?.code ?? ''}`;
    },
  },
  {
    id: 'R14',
    name: '已登录：门户主要页面可打开',
    run: async (ctx) => {
      requireCookie(ctx);
      const pages = ['/overview', '/dashboard', '/models', '/activities', '/guide'];
      const broken = [];
      for (const page of pages) {
        const res = await ctx.http(ctx.portal(page));
        if (res.status !== 200) broken.push(`${page}=${res.status}`);
        else if (!/text\/html/i.test(res.contentType)) broken.push(`${page}=${res.contentType}`);
      }
      need(
        broken.length === 0,
        `页面异常：${broken.join(', ')}`,
        '3xx 多为会话失效或初始化未完成（先去 /setup 走完向导）；500 按 x-request-id 查日志'
      );
      return `${pages.length} 个页面 200`;
    },
  },
  {
    id: 'R15',
    name: '成员站健康检查',
    run: async (ctx) => {
      const res = await ctx.http(ctx.member('/api/health'));
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status, '成员站'));
      const body = assertJson(res, '成员站健康检查');
      need(body.status === 'ok', `status 应为 ok，实际 ${JSON.stringify(body.status)}`);
      return 'status=ok';
    },
  },
  {
    id: 'R16',
    name: '成员站：未登录跳登录页',
    run: async (ctx) => {
      const res = await ctx.http(ctx.member('/members'), { cookie: '' });
      need(res.status >= 300 && res.status < 400, `期望 3xx，实际 ${res.status}`, hintForStatus(res.status, '成员站'));
      need(res.location.includes('/login'), `跳转目标不含 /login：${res.location || '（无 Location）'}`);
      return `${res.status} → ${res.location.replace(/^https?:\/\/[^/]+/, '')}`;
    },
  },
  {
    id: 'R17',
    name: '成员站：未登录接口 → 401',
    run: async (ctx) => {
      const res = await ctx.http(ctx.member('/api/portal/members'), { cookie: '' });
      need(res.status === 401, `期望 401，实际 ${res.status}`, hintForStatus(res.status, '成员站'));
      return '401';
    },
  },
  {
    id: 'R18',
    name: '成员站登录页可访问',
    run: async (ctx) => {
      const res = await ctx.http(ctx.member('/login'), { cookie: '' });
      need(res.status === 200, `期望 200，实际 ${res.status}`, hintForStatus(res.status, '成员站'));
      need(/text\/html/i.test(res.contentType), `content-type 不是 HTML：${res.contentType}`);
      need(res.text.includes('登录'), '页面里找不到"登录"字样');
      return '200 html';
    },
  },
  {
    id: 'R19',
    name: '跨站会话互认：成员站读取自己的申请单',
    run: async (ctx) => {
      requireCookie(ctx);
      const res = await ctx.http(ctx.member('/api/portal/members'));
      need(
        res.status === 200,
        `期望 200，实际 ${res.status}`,
        res.status === 401
          ? '两站 SESSION_SECRET 或 PORTAL_COOKIE_PATH 不一致，Cookie 带不过去'
          : hintForStatus(res.status, '成员站')
      );
      const body = assertJson(res, '成员申请单');
      need('application' in body, '响应缺少 application 字段');
      return body.application ? `申请单状态 ${body.application.status}` : '尚无申请单';
    },
  },
  {
    id: 'R20',
    name: '已登录：成员站页面可打开',
    run: async (ctx) => {
      requireCookie(ctx);
      const pages = ['/members'];
      const broken = [];
      for (const page of pages) {
        const res = await ctx.http(ctx.member(page));
        if (res.status !== 200) broken.push(`${page}=${res.status}`);
      }
      need(broken.length === 0, `页面异常：${broken.join(', ')}`, '3xx 多为会话未互认或 basePath 与访问地址不一致');
      return `${pages.length} 个页面 200`;
    },
  },
];

const { ok } = await runSuite({
  title: '端到端 · 只读验收（线上可执行）',
  description: '只发 GET，不登录不写数据；提供 Cookie 时追加已登录读检查。',
  targets,
  cases,
});

process.exit(ok ? 0 : 1);
