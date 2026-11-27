/**
 * 全局管理员判定（成员自购站）。
 *
 * 两个来源，任一命中即为管理员：
 * 1. 引导期账号密码登录的本地身份（`local:<username>`，凭据只来自 env）；
 * 2. 共享层 `portal_shared.admins` 名单命中。
 *
 * 名单为空时靠**首登认领**破局（见下方说明）。`ADMIN_EMAILS` 邮箱白名单已移除：
 * IdP 不返回邮箱时整条失效，且邮箱可被改写，不该成为提权依据——
 * 管理员只有一个权威来源，就是名单表。
 *
 * 与统一采买站（assign）的差异：**不读取任何网关状态**——原来的第 4 层
 * 「回落到 onboarding owner」需要访问网关 `system_config`，成员站在没有网关的部署里
 * 会因此永远判定不出管理员。改为首登认领后，功能自洽且不依赖外部系统。
 *
 * **认领只发生在登录签发那一刻**（`claimFirstAdminOnLogin`），不在 `resolvePortalAdmin`
 * 这个读判定里。原因是 `resolvePortalAdmin` 被每个管理接口调用：若在读路径上写库，
 * 任何一次越权尝试都会先产生一条写操作，副作用既不可控也不可审计。
 *
 * 名单共享的意义：两站同时部署时，任一侧加的管理员对另一侧立即生效；Cookie 过期
 * 重新登录后判定仍然一致（不依赖会话里的 admin claim）。
 */

import { ensureConfigOverlayLoaded } from '@/lib/config/overlay';
import { claimFirstAdmin, addAdmins, isValidAdminSub, readAdminSubs } from '@/lib/admin/roster';
import { isLocalAdminSub } from './local-admin';
import type { SessionIdentity } from './session';

export type AdminIdentity = {
  /** external_user_id，形如 `school_id:user_id` */
  sub: string;
  email?: string | null;
};

/**
 * 会话身份是否管理员（异步，每次实时判定）。
 *
 * 判定顺序：本地引导账号 → 共享名单；两者都未命中即非管理员。
 *
 * **纯读**：这里不写库、不做首登认领。认领由登录签发时的
 * `claimFirstAdminOnLogin` 负责，避免"读判定"带上写副作用。
 * 冷启动时 overlay 可能还没加载，判定前先等一次（上限 1 秒），
 * 避免刚启动就把管理员判成非管理员。
 */
export async function resolvePortalAdmin(identity: AdminIdentity): Promise<boolean> {
  await ensureConfigOverlayLoaded();

  // 引导身份只认配置里的那一个 sub：凭据被清空后它自然不成立
  if (isLocalAdminSub(identity.sub)) return true;

  if (!identity.sub) return false;

  const { subs } = await readAdminSubs();
  if (subs.includes(identity.sub)) return true;

  // 名单为空时不再在这里认领：读路径 fail-closed，认领见 claimFirstAdminOnLogin。
  // 这里返回 false 不会把首个管理员挡在门外——他的会话是在登录时认领后才签发的。
  return false;
}

/**
 * 全新部署的首登认领：把首个合法登录者写进管理员名单。
 *
 * **只能在登录签发路径上调用**（`establishSession`），不要放进 `resolvePortalAdmin`
 * 这类读判定里，否则任何一次管理接口的探测都会触发写库。
 *
 * 三条约束由 `claimFirstAdmin` 保证：只接受 `school_id:user_id` 形式的身份、
 * 用固定 advisory lock 串行化（双站同时首登不会各认领一个）、写库异常按未认领处理
 * （登录不能因为认领失败而失败）。
 */
export async function claimFirstAdminOnLogin(sub: string): Promise<boolean> {
  const claimed = await claimFirstAdmin(sub);
  if (claimed) {
    // 动态 import：`audit` 会拉进 config / secrets，而本模块处在认证与 middleware 的
    // 公共 import 链上（`middleware` → `auth/login` → 本文件）。静态引入会形成
    // 循环依赖，让 audit 里的 `getConfig()` 拿到未初始化的绑定、脱敏直接失效。
    const { audit } = await import('@/lib/audit');
    // 认领是权限来源的变更，必须留痕：谁、什么时候、以什么方式拿到管理员
    audit('member.admin', {
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
 * **所有签发点都必须走这里**：成员站没有开户重签，只有登录一处。
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
    // 动态 import：配置模块会拉到 overlay / secrets，避免认证链路形成循环依赖
    const { getConfig } = await import('@/lib/config');
    const expected = new Set(
      (getConfig().auth.adminRoles ?? []).map(normalizeRole).filter(Boolean)
    );
    if (expected.size === 0) return false;

    const matched = actual.filter((role) => expected.has(role));
    if (matched.length === 0) return false;
    if (!isValidAdminSub(identity.sub)) return false;

    await addAdmins([identity.sub]);

    const { audit } = await import('@/lib/audit');
    audit('member.admin', {
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
