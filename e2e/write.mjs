#!/usr/bin/env node
/**
 * 端到端用例（二）：写入链路。只在本地 / 测试环境执行，不要打线上。
 *
 * 覆盖"写进去 → 读回来 → 恢复原状"的完整链路，每一项都自带清理：
 *   1. 引导账号密码登录（拿会话）
 *   2. 未登录写入必须被拒（鉴权兜底）
 *   3. 网关开户（幂等）
 *   4. 密钥：创建 → 列表可见 → 吊销 → 列表消失
 *   5. 运行期配置：改 loginSubtitle → 读回 → 还原
 *   6. 运营活动配置：追加一个测试活动 → 读回 → 还原
 *   7. 管理员名单：添加 → 读回 → 移除
 *   8. 成员站配置写入（跨站共享同一份配置）
 *   9. 成员站申请单据（默认关闭，需 --with-member-application）
 *
 * 用法：
 *   node e2e/write.mjs                          # 默认读 campus-tokenhub-assign/.env.dual 的引导账号
 *   node e2e/write.mjs --user admin --password '...'
 *   node e2e/write.mjs --origin http://127.0.0.1:8088
 *
 * 账号密码登录被关掉时（本地配好 SSO 后常见，库内 local_admin_mode=off 优先于 env），
 * 用学校测试账号在浏览器登录，把 Cookie 传进来即可跳过登录那一步：
 *   node e2e/write.mjs --cookie "portal_session=..."
 *
 * 环境变量：E2E_ADMIN_USER / E2E_ADMIN_PASSWORD / E2E_ORIGIN / E2E_PORTAL_BASE /
 * E2E_MEMBER_BASE / E2E_GATEWAY_BASE / E2E_TIMEOUT_MS。
 *
 * 安全护栏：目标不是本机地址时必须显式加 --allow-remote，避免误改线上数据。
 * 退出码：0 = 全部通过（跳过项不算失败），1 = 有失败项或环境不满足。
 */

import process from 'node:process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SESSION_COOKIE,
  hintForStatus,
  need,
  parseArgs,
  resolveTargets,
  runSuite,
  sessionCookieFrom,
  skip,
} from './lib/harness.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs();
const targets = resolveTargets(options);

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '0.0.0.0', '[::1]', 'host.docker.internal']);

/** 写入用例的第一道防线：默认只允许打本机 */
function assertLocalTargets() {
  const remote = [targets.portal, targets.member]
    .map((url) => new URL(url).hostname)
    .filter((host) => !LOCAL_HOSTS.has(host));
  if (remote.length === 0) return;
  if (options['allow-remote'] === true) {
    console.log(`\n⚠️  已允许写入远端目标：${[...new Set(remote)].join(', ')}（--allow-remote）\n`);
    return;
  }
  console.error(
    `\n❌ 写入用例只允许打本机：当前目标是 ${remote.join(', ')}\n` +
      '   确实要在测试环境执行时，显式追加 --allow-remote。\n'
  );
  process.exit(1);
}

function readEnvFile(file) {
  const map = {};
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[match[1]] = value;
  }
  return map;
}

/** 凭据来源顺序：命令行 > 环境变量 > 项目 env 文件（与部署脚本同一份来源） */
function resolveCredentials() {
  const user = (typeof options.user === 'string' && options.user) || process.env.E2E_ADMIN_USER || '';
  const password =
    (typeof options.password === 'string' && options.password) || process.env.E2E_ADMIN_PASSWORD || '';
  if (user && password) return { user, password, source: '命令行 / 环境变量' };

  for (const name of ['.env.dual', '.env']) {
    const file = path.join(REPO_ROOT, 'campus-tokenhub-assign', name);
    if (!existsSync(file)) continue;
    const map = readEnvFile(file);
    if (map.PORTAL_ADMIN_USERNAME && map.PORTAL_ADMIN_PASSWORD) {
      return {
        user: map.PORTAL_ADMIN_USERNAME,
        password: map.PORTAL_ADMIN_PASSWORD,
        source: `campus-tokenhub-assign/${name}`,
      };
    }
  }
  return null;
}

const credentials = resolveCredentials();

/** 解出会话里的身份，用来判断"当前身份能不能做需要学校身份的写入" */
function decodeSession(cookieValue) {
  const token = String(cookieValue ?? '').replace(new RegExp(`^${SESSION_COOKIE}=`), '');
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function errorCode(res) {
  return res.json?.code ? String(res.json.code) : '';
}

/** 统一的"期望状态码"断言，失败时带上排障提示 */
function expectStatus(res, expected, label) {
  const allowed = Array.isArray(expected) ? expected : [expected];
  need(
    allowed.includes(res.status),
    `${label}：期望 ${allowed.join('/')}，实际 ${res.status}${res.text ? ` ${res.text.slice(0, 160)}` : ''}`,
    hintForStatus(res.status)
  );
}

function jsonOf(res, label) {
  need(res.json !== null, `${label} 返回的不是 JSON（HTTP ${res.status}）`, hintForStatus(res.status));
  return res.json;
}

const cases = [
  {
    id: 'W1',
    name: '前置：门户健康 + 网关可用',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/api/health'), { cookie: '' });
      expectStatus(res, 200, '健康检查');
      const body = jsonOf(res, '健康检查');
      need(body.status === 'ok', `status 应为 ok，实际 ${JSON.stringify(body.status)}`);
      need(
        body.gateway === true,
        '网关不可达：开户与密钥用例必然失败，先修 gateway-proxy / gateway-admin',
        'docker compose ps 看 gateway-proxy / gateway-admin 是否 healthy'
      );
      return 'status=ok gateway=true';
    },
  },
  {
    id: 'W2',
    name: '引导账号密码登录',
    run: async (ctx) => {
      // 已经用 --cookie 给了学校 SSO 会话时，不再走引导账号（线上 SSO 环境可能已关闭密码登录）
      if (ctx.cookie) skip('已通过 --cookie 提供会话，跳过密码登录');
      if (!credentials) {
        skip('未找到引导账号：用 --user/--password 或 E2E_ADMIN_USER/E2E_ADMIN_PASSWORD，或在 .env.dual 里配 PORTAL_ADMIN_*');
      }
      const res = await ctx.http(ctx.portal('/api/auth/password'), {
        method: 'POST',
        form: { username: credentials.user, password: credentials.password, next: '/settings', dest: '' },
        cookie: '',
      });
      const code = new URL(res.location || 'http://invalid/').searchParams.get('error');
      if (code) {
        const hints = {
          password_unconfigured: '库里没有引导账号凭据：确认 compose 注入了 PORTAL_ADMIN_USERNAME / _PASSWORD',
          password_disabled:
            '账号密码登录已被关闭（库内 local_admin_mode=off，优先于 env）：改用 --cookie 传学校测试账号的会话，或到「设置 → 登录认证」把它改回 auto/on',
          password_invalid: '口令不匹配：.env 里的值与当前数据库里的不一致（库内值优先于 env）',
          password_rate_limited: '同一 IP 失败次数过多：等 1 分钟再试',
          origin_mismatch: 'Origin 与 Host 不一致：确认 --origin 与实际访问地址同源',
        };
        throw Object.assign(new Error(`登录被拒绝：${code}`), { hint: hints[code] ?? '看门户日志里的 auth.login.fail 审计' });
      }
      expectStatus(res, [302, 303], '登录');
      const cookie = sessionCookieFrom(res);
      need(
        cookie,
        '登录成功但没有 Set-Cookie: portal_session',
        '检查 SESSION_SECRET 是否注入、COOKIE_SECURE 是否与访问协议匹配（http 配 true 会导致浏览器丢弃 Cookie）'
      );
      ctx.cookie = cookie;
      const session = decodeSession(cookie);
      ctx.state.session = session;
      return `已获取会话（sub=${session?.sub ?? '未解析'}，来源 ${credentials.source}）`;
    },
  },
  {
    id: 'W3',
    name: '未登录写入被拒绝',
    run: async (ctx) => {
      const res = await ctx.http(ctx.portal('/api/portal/keys'), { method: 'POST', cookie: '' });
      expectStatus(res, 401, '未登录创建密钥');
      const settings = await ctx.http(ctx.portal('/api/portal/settings'), {
        method: 'PUT',
        body: { values: {}, clear: [] },
        cookie: '',
      });
      expectStatus(settings, 401, '未登录写配置');
      return '401 / 401';
    },
  },
  {
    id: 'W4',
    name: '网关开户（幂等）',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const res = await ctx.http(ctx.portal('/api/portal/provision'), { method: 'POST' });
      if (res.status === 502) {
        throw Object.assign(new Error('开户失败：门户调不通网关 admin 接口'), {
          hint: '检查门户的 OCTAFUSE_ADMIN_BASE 与 OCTAFUSE_ADMIN_API_KEY（网关后台集成密钥）是否有效、权限是否齐全',
        });
      }
      expectStatus(res, 200, '开户');
      const body = jsonOf(res, '开户');
      need(body.ok === true && body.octafuse_user_id, `开户响应异常：${res.text.slice(0, 160)}`);
      const refreshed = sessionCookieFrom(res);
      if (refreshed) ctx.cookie = refreshed;
      return `octafuse_user_id=${body.octafuse_user_id}`;
    },
  },
  {
    id: 'W5',
    name: '密钥：创建 → 列表可见 → 吊销 → 列表消失',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const listBefore = await ctx.http(ctx.portal('/api/portal/keys'));
      expectStatus(listBefore, 200, '密钥列表');
      const before = jsonOf(listBefore, '密钥列表');
      need(before.ready === true, '账号未开通（ready=false）：W4 开户没生效');
      const active = (before.keys ?? []).filter((key) => key.status === 'active');
      if (active.length > 0) {
        skip(`账号已有 ${active.length} 把有效密钥（"一人一把"策略），跳过创建/吊销；如需重跑请先在门户吊销旧密钥`);
      }

      const created = await ctx.http(ctx.portal('/api/portal/keys'), { method: 'POST' });
      expectStatus(created, 201, '创建密钥');
      const payload = jsonOf(created, '创建密钥');
      need(typeof payload.key === 'string' && payload.key.length >= 16, `密钥明文异常：${String(payload.key).slice(0, 8)}…`);
      need(typeof payload.key_id === 'string' && payload.key_id, '响应缺少 key_id');

      const keyId = payload.key_id;
      ctx.state.keyRevoked = false;
      try {
        const listed = await ctx.http(ctx.portal('/api/portal/keys'));
        const body = jsonOf(listed, '密钥列表');
        const hit = (body.keys ?? []).find((key) => key.id === keyId);
        need(hit, `新密钥 ${keyId} 未出现在列表里`);
        need(String(hit.key).includes('••••'), '列表返回了密钥明文，应只给掩码');

        const revoked = await ctx.http(ctx.portal(`/api/portal/keys/${encodeURIComponent(keyId)}`), {
          method: 'DELETE',
        });
        expectStatus(revoked, 200, '吊销密钥');
        ctx.state.keyRevoked = true;

        const after = jsonOf(await ctx.http(ctx.portal('/api/portal/keys')), '密钥列表');
        need(
          !(after.keys ?? []).some((key) => key.id === keyId),
          '吊销后密钥仍在列表里'
        );
        return '创建 201 → 列表命中 → 吊销 200 → 列表消失';
      } finally {
        if (!ctx.state.keyRevoked) {
          // 中途失败也要尽力回收，避免下次运行被"一人一把"挡住
          await ctx
            .http(ctx.portal(`/api/portal/keys/${encodeURIComponent(keyId)}`), { method: 'DELETE' })
            .catch(() => undefined);
        }
      }
    },
  },
  {
    id: 'W6',
    name: '运行期配置：写入 → 读回 → 还原',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const field = 'loginSubtitle';
      const read = async () => {
        const res = await ctx.http(ctx.portal('/api/portal/settings'));
        expectStatus(res, 200, '读取配置');
        return jsonOf(res, '读取配置');
      };

      const before = await read();
      const original = before.values?.[field];
      const marker = `E2E 写入验证 ${new Date().toISOString().slice(11, 19)}`;
      let restored = false;
      try {
        const put = await ctx.http(ctx.portal('/api/portal/settings'), {
          method: 'PUT',
          body: { values: { [field]: marker }, clear: [] },
        });
        expectStatus(put, 200, '写配置');
        need(jsonOf(put, '写配置').ok === true, '写配置响应缺少 ok:true');

        const after = await read();
        need(
          after.values?.[field] === marker,
          `写入后读回不一致：期望「${marker}」，实际「${String(after.values?.[field])}」`,
          '多副本部署时可能是内存 overlay 未刷新或读写打到了不同副本'
        );
      } finally {
        const restoreBody =
          typeof original === 'string'
            ? { values: { [field]: original }, clear: [] }
            : { values: {}, clear: [field] };
        const restore = await ctx.http(ctx.portal('/api/portal/settings'), { method: 'PUT', body: restoreBody });
        restored = restore.status === 200;
        if (!restored) {
          throw Object.assign(new Error(`还原 ${field} 失败：HTTP ${restore.status} ${restore.text.slice(0, 120)}`), {
            hint: `原值：${typeof original === 'string' ? original : '（未显式配置，应 clear）'}，请到设置页手工改回`,
          });
        }
      }
      const final = await read();
      need(
        final.values?.[field] === original,
        `${field} 还原后与原始值不一致（原值 ${String(original)}，现值 ${String(final.values?.[field])}）`
      );
      return `${field} 写入 → 读回 → 还原`;
    },
  },
  {
    id: 'W7',
    name: '运营活动配置：追加 → 读回 → 还原',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const read = async () => {
        const res = await ctx.http(ctx.portal('/api/portal/activities/config'));
        expectStatus(res, 200, '读取活动配置');
        const body = jsonOf(res, '读取活动配置');
        need(Array.isArray(body.activities), '响应缺少 activities 数组');
        return body.activities;
      };

      const original = await read();
      const marker = `e2e-check-${Date.now().toString(36)}`;
      const testActivity = {
        id: marker,
        title: 'E2E 测试活动',
        points: 1,
        summary: ['端到端写入用例自动创建，跑完即删'],
        period: 'once',
        enabled: false,
      };

      let didWrite = false;
      try {
        const next = [...original, testActivity];
        const put = await ctx.http(ctx.portal('/api/portal/activities/config'), {
          method: 'PUT',
          body: { activities: next },
        });
        if (put.status === 400 && /最多配置/.test(put.text)) {
          skip(`活动数量已达上限（${original.length} 个），跳过追加；未改动数据`);
        }
        expectStatus(put, 200, '写活动配置');
        didWrite = true;

        const after = await read();
        need(
          after.some((item) => item.id === marker),
          `写入后读回没看到 ${marker}（实际 ${after.length} 个活动）`
        );
      } finally {
        if (didWrite) {
          const restore = await ctx.http(ctx.portal('/api/portal/activities/config'), {
            method: 'PUT',
            body: { activities: original },
          });
          if (restore.status !== 200) {
            throw Object.assign(new Error(`还原活动配置失败：HTTP ${restore.status} ${restore.text.slice(0, 120)}`), {
              hint: `请到「运营活动」页删掉 id=${marker} 的测试活动`,
            });
          }
        }
      }
      const final = await read();
      need(!final.some((item) => item.id === marker), '还原后测试活动仍在列表里');
      return `${original.length} 个活动 → 追加 → 还原`;
    },
  },
  {
    id: 'W8',
    name: '管理员名单：添加 → 页面可见 → 移除',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const sub = `e2e-check:${String(Date.now()).slice(-8)}`;
      // 名单没有读接口，页面（服务端渲染）是唯一读路径，因此用页面验证"真的写进共享库了"
      const pageHas = async (target) => {
        const page = await ctx.http(ctx.portal('/settings/admins'));
        need(
          page.status === 200,
          `管理员页面期望 200，实际 ${page.status}`,
          page.status === 403 || (page.status >= 300 && page.status < 400)
            ? '当前会话不是全局管理员（或会话已失效），名单页会重定向'
            : hintForStatus(page.status)
        );
        return page.text.includes(target);
      };

      let added = false;
      let removed = false;
      try {
        const post = await ctx.http(ctx.portal('/api/portal/admins'), { method: 'POST', body: { subs: [sub] } });
        expectStatus(post, 200, '添加管理员');
        added = true;
        need(jsonOf(post, '添加管理员').subs.includes(sub), `添加后接口返回的名单里没有 ${sub}`);
        need(await pageHas(sub), '添加后管理员页面没有出现测试身份（写入没落到共享库？）');

        const remove = await ctx.http(ctx.portal('/api/portal/admins'), { method: 'DELETE', body: { sub } });
        expectStatus(remove, 200, '移除管理员');
        removed = true;
        need(!jsonOf(remove, '移除管理员').subs.includes(sub), '移除后接口返回的名单里仍有测试身份');
        need(!(await pageHas(sub)), '移除后管理员页面仍显示测试身份');
        return `${sub} 添加 → 页面可见 → 移除`;
      } finally {
        if (added && !removed) {
          await ctx
            .http(ctx.portal('/api/portal/admins'), { method: 'DELETE', body: { sub } })
            .catch(() => undefined);
        }
      }
    },
  },
  {
    id: 'W9',
    name: '成员站配置写入（跨站共享）',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const field = 'footerContact';
      const read = async () => {
        const res = await ctx.http(ctx.member('/api/portal/settings'));
        if (res.status === 401) {
          throw Object.assign(new Error('成员站不认这份会话（HTTP 401）'), {
            hint: '两站 SESSION_SECRET / PORTAL_COOKIE_PATH 不一致，跨站会话互认没生效',
          });
        }
        expectStatus(res, 200, '读取成员站配置');
        return jsonOf(res, '读取成员站配置');
      };

      const before = await read();
      const original = before.values?.[field];
      const marker = `E2E 成员站 ${new Date().toISOString().slice(11, 19)}`;
      try {
        const put = await ctx.http(ctx.member('/api/portal/settings'), {
          method: 'PUT',
          body: { values: { [field]: marker }, clear: [] },
        });
        expectStatus(put, 200, '写成员站配置');
        const after = await read();
        need(after.values?.[field] === marker, `成员站写入后读回不一致（实际「${String(after.values?.[field])}」）`);
      } finally {
        const restoreBody =
          typeof original === 'string'
            ? { values: { [field]: original }, clear: [] }
            : { values: {}, clear: [field] };
        const restore = await ctx.http(ctx.member('/api/portal/settings'), { method: 'PUT', body: restoreBody });
        if (restore.status !== 200) {
          throw Object.assign(new Error(`还原成员站 ${field} 失败：HTTP ${restore.status}`), {
            hint: `原值：${typeof original === 'string' ? original : '（未显式配置，应 clear）'}`,
          });
        }
      }
      return `${field} 成员站写入 → 读回 → 还原`;
    },
  },
  {
    id: 'W10',
    name: '成员站申请单据：提交 → 读回 → 驳回',
    enabled: () => options['with-member-application'] === true,
    skipReason: '默认关闭（会留下一条 rejected 记录）：需要时加 --with-member-application',
    run: async (ctx) => {
      if (!ctx.cookie) skip('未登录（W2 未通过）');
      const session = ctx.state.session ?? decodeSession(ctx.cookie);
      if (!/^[^:]+:\d+$/.test(session?.sub ?? '')) {
        skip(`当前身份 ${session?.sub ?? '未知'} 不是 school_id:user_id，接口会按 invalid_identity 拒绝；用学校 SSO 会话再跑`);
      }

      const mine = await ctx.http(ctx.member('/api/portal/members'));
      expectStatus(mine, 200, '读取自己的申请单');
      const existing = jsonOf(mine, '读取自己的申请单').application;
      if (existing) skip(`已有申请单（status=${existing.status}），跳过以免覆盖真实单据`);

      const submit = await ctx.http(ctx.member('/api/portal/members'), {
        method: 'POST',
        body: {
          email: 'e2e-check@example.edu',
          countryCode: '86',
          phone: '13800001234',
          departmentPath: 'E2E测试部门',
          remark: '端到端用例自动创建',
        },
      });
      if (submit.status === 503) skip('成员账号申请未开放（腾讯云成员账号未配置）');
      if (submit.status === 403) skip(`接口拒绝当前身份：${errorCode(submit) || submit.text.slice(0, 80)}`);
      expectStatus(submit, 200, '提交申请');

      const app = jsonOf(submit, '提交申请').application;
      need(app?.id, '提交后没有返回申请单 id');
      need(app.status === 'pending', `新单据状态应为 pending，实际 ${app.status}`);

      const reject = await ctx.http(ctx.member(`/api/portal/members/${app.id}/review`), {
        method: 'POST',
        body: { action: 'reject', note: 'E2E 自动用例收尾' },
      });
      if (reject.status === 503) {
        throw Object.assign(new Error('单据已提交但审核接口不可用，单据留在 pending'), {
          hint: `请到成员站「审核」页驳回 id=${app.id}（备注：E2E 自动用例）`,
        });
      }
      expectStatus(reject, 200, '驳回申请');
      const final = await ctx.http(ctx.member('/api/portal/members'));
      need(
        jsonOf(final, '读取自己的申请单').application?.status === 'rejected',
        '驳回后单据状态不是 rejected'
      );
      return `提交 pending → 驳回 rejected（记录保留，可重新申请）`;
    },
  },
];

assertLocalTargets();

const { ok } = await runSuite({
  title: '端到端 · 写入链路（仅本地 / 测试环境）',
  description: '写入后自动还原；最后一项默认关闭。',
  targets,
  cases,
});

process.exit(ok ? 0 : 1);
