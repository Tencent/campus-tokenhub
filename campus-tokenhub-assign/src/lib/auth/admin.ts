/**
 * 全局管理员判定。
 *
 * 两个来源，任一命中即为管理员：
 * 1. 引导期账号密码登录的本地身份（`local:<username>`，凭据只来自 env）；
 * 2. 命中数据库管理员名单（`portal_shared.admins`，设置页维护，按 `school_id:user_id` 判定）。
 *
 * 为什么需要第 1 种：学校还没对接 SSO 的部署没有任何会话来源，而 `/settings` 要管理员才能进，
 * 没有这条就没有配置 SSO 的入口（详见 `auth/local-admin.ts`）。
 *
 * 名单为空时靠「首登认领」破局：**登录签发那一刻**把首个合法身份写进名单
 * （`claimFirstAdminOnLogin`）。原来的两条兜底都已去掉：
 * - `ONBOARDING_OWNER`（网关里的初始化负责人）——同一件事存在两套口径，
 *   加上管理台读的是旧表，会出现「门户是管理员、管理台没权限」；
 * - `ADMIN_EMAILS` 邮箱白名单——IdP 不返回邮箱时整条失效，且邮箱可被改写，
 *   不该成为提权依据。
 * 现在管理员只有一个权威来源：`portal_shared.admins`。
 *
 * 侧边栏入口、管理台 SSO 的 `admin` 声明、初始化相关接口共用这里，避免页面放行、接口拒绝。
 */

import { ensureConfigOverlayLoaded } from '@/lib/config/overlay';
import { isLocalAdminSub } from './local-admin';
import type { SessionIdentity } from './session';

/** 数据库管理员名单是否非空（读取失败按「空」处理，仅用于初始化页的首次引导） */
export async function hasAdminRoster(): Promise<boolean> {
  try {
    const { readAdminSubs } = await import('@/lib/admin/roster');
    const { subs, degraded } = await readAdminSubs();
    return !degraded && subs.length > 0;
  } catch {
    return false;
  }
}

export type AdminIdentity = {
  /** external_user_id，形如 `school_id:user_id` */
  sub: string;
  email?: string | null;
};

/**
 * 会话身份是否管理员（异步，每次实时判定）。
 *
 * 判定顺序：本地引导账号 → 共享名单。**纯读**：不写库、不做首登认领，
 * 否则任何一次越权探测都会先产生一条写操作。认领见 `claimFirstAdminOnLogin`。
 *
 * 冷启动时 overlay 可能还没加载，判定前先等一次（上限 1 秒），
 * 避免刚启动就把管理员判成非管理员。
 */
export async function resolvePortalAdmin(identity: AdminIdentity): Promise<boolean> {
  await ensureConfigOverlayLoaded();

  // 引导身份只认配置里的那一个 sub：凭据被清空后它自然不成立
  if (isLocalAdminSub(identity.sub)) return true;

  if (!identity.sub) return false;

  // 动态导入：部分单测会整体替换 roster，缺导出时按「无名单」处理而不是 500
  try {
    const { readAdminSubs } = await import('@/lib/admin/roster');
    const { subs } = await readAdminSubs();
    return subs.includes(identity.sub);
  } catch {
    return false;
  }
}

/**
 * 全新部署的首登认领：把首个合法登录者写进管理员名单。
 *
 * **只能在登录签发路径上调用**（`establishSession` / 开户重签），不要放进
 * `resolvePortalAdmin` 这类读判定里，否则任何一次管理接口的探测都会触发写库。
 *
 * 三条约束由 `claimFirstAdmin` 保证：只接受 `school_id:user_id` 形式的身份、
 * 用固定 advisory lock 串行化（双站同时首登不会各认领一个）、写库异常按未认领处理
 * （登录不能因为认领失败而失败）。
 */
export async function claimFirstAdminOnLogin(sub: string): Promise<boolean> {
  if (!sub) return false;
  // 引导身份不进名单：它本来就凭凭据即管理员，写进名单反而在凭据清理后残留一个管理员
  if (isLocalAdminSub(sub)) return false;

  const { claimFirstAdmin } = await import('@/lib/admin/roster');
  const claimed = await claimFirstAdmin(sub);
  if (claimed) {
    // 动态 import：`audit` 会拉进 config / secrets，而本模块处在认证与 middleware 的
    // 公共 import 链上（`middleware` → `auth/login` → 本文件）。静态引入会形成
    // 循环依赖，让 audit 里的 `getConfig()` 拿到未初始化的绑定、脱敏直接失效。
    const { audit } = await import('@/lib/audit');
    // 认领是权限来源的变更，必须留痕：谁、什么时候、以什么方式拿到管理员
    audit('portal.admin', {
      actor_external_id: sub,
      target: 'portal_shared.admins',
      result: 'first_login_claim',
      detail: '管理员名单为空，首个登录身份自动认领',
    });
  }
  return claimed;
}

/**
 * 给会话身份补上管理员声明。
 *
 * **所有签发点都必须走这里**：登录（`establishSession`）、开户重签
 * （`POST /api/portal/provision`）、管理台回跳（`admin-entry`）——
 * 漏一处就会让管理员在重签后静默降权。
 */
export async function withAdminClaim(identity: SessionIdentity): Promise<SessionIdentity> {
  const admin = await resolvePortalAdmin(identity);
  return admin ? { ...identity, admin: true } : identity;
}

/** 角色比较口径：trim + 小写，与登录限制的条件比较保持一致 */
function normalizeRole(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 角色自动同步管理员：登录用户的角色命中配置值时，把该账号写进管理员名单。
 *
 * **只增不删**：角色变动只影响本次是否补充，不会撤销已授予的管理员——
 * 自动撤权可能把唯一管理员锁在门外，撤销仍走管理台手动操作。
 *
 * 只在登录签发路径（`establishSession`）调用；写库失败按「未同步」处理，
 * 不能让一次权限同步失败把正常登录拦下来。
 */
export async function syncAdminRolesOnLogin(identity: {
  sub: string;
  roles?: string[];
}): Promise<boolean> {
  if (!identity.sub) return false;
  if (isLocalAdminSub(identity.sub)) return false;

  const actual = (identity.roles ?? []).map(normalizeRole).filter(Boolean);
  if (actual.length === 0) return false;

  try {
    await ensureConfigOverlayLoaded();
    // 动态 import：与 claimFirstAdminOnLogin 同一原因，避免认证链路上的循环依赖
    const [{ getConfig }, roster] = await Promise.all([
      import('@/lib/config'),
      import('@/lib/admin/roster'),
    ]);
    const expected = new Set(
      (getConfig().auth.adminRoles ?? []).map(normalizeRole).filter(Boolean)
    );
    if (expected.size === 0) return false;

    const matched = actual.filter((role) => expected.has(role));
    if (matched.length === 0) return false;
    if (!roster.isValidAdminSub(identity.sub)) return false;

    await roster.addAdmins([identity.sub]);

    const { audit } = await import('@/lib/audit');
    audit('portal.admin', {
      actor_external_id: identity.sub,
      target: 'portal_shared.admins',
      result: 'role_sync',
      detail: `登录角色命中自动同步规则：${matched.join(',')}`,
    });
    return true;
  } catch {
    return false;
  }
}
