/**
 * 初始化入口的访问控制。
 *
 * 规则：
 * - 入口只对管理员展示：管理员 = 引导账号 / 数据库管理员名单 / （名单为空时的）初始化 owner。
 *   全程按 `external_user_id` 判定，不依赖 IdP 是否返回邮箱。
 * - 第一个进入初始化页的登录身份成为 owner；owner 写进网关 `system_config`。
 * - 已完成（`ONBOARDING_COMPLETED` 存在）后仍可重跑：写入是幂等补缺，重跑会刷新完成时间。
 */

import { ApiError } from '@/lib/api/guard';
import { hasAdminRoster, resolvePortalAdmin } from '@/lib/auth/admin';
import type { SessionPayload } from '@/lib/auth/session';
import { readOnboardingSnapshot, resolveOwner, type OwnerResolution } from './state';

/**
 * 是否管理员（写操作口径）：名单命中，或名单为空时就是网关里的初始化 owner。
 * 网关不可用时按非管理员处理，不把写入权限当成默认值。
 */
export async function isSetupAdmin(session: SessionPayload): Promise<boolean> {
  // 判定口径与管理台 SSO / 侧边栏入口完全一致
  return resolvePortalAdmin({ sub: session.sub, email: session.email });
}

/**
 * 是否展示 / 允许进入初始化页。
 *
 * 除管理员外，还放行「尚未有人认领 owner」时的访客：第一所学校的首次部署没有管理员可依据，
 * 认领 owner 这个动作本身发生在页面里（见 `resolveOwner`）。
 */
export async function canAccessSetup(session: SessionPayload): Promise<boolean> {
  if (await resolvePortalAdmin({ sub: session.sub, email: session.email })) return true;
  try {
    const { completed, owner } = await readOnboardingSnapshot();
    if (owner) return owner === session.sub;
    return !completed && !(await hasAdminRoster());
  } catch {
    return false;
  }
}

/** 页面用：不做抛错，返回完整状态交给页面决定展示什么。 */
export async function getSetupAccess(session: SessionPayload): Promise<OwnerResolution> {
  return resolveOwner(session.sub);
}

/**
 * API 用：非管理员 / 非 owner 一律拒绝。
 *
 * 已完成不拦：重跑用于「第一次少选了模型」或换 Key，写入本身是幂等补缺，
 * 未勾选的模型不会被删除（见 `apply.ts` 的 plan/apply）。
 */
export async function requireSetupAccess(session: SessionPayload): Promise<OwnerResolution> {
  if (!(await isSetupAdmin(session))) {
    throw new ApiError(403, '初始化仅对全局管理员开放', 'not_setup_admin');
  }
  const ownership = await resolveOwner(session.sub);
  if (!ownership.isOwner) {
    throw new ApiError(403, '初始化已由其他账号接管，请联系该账号操作', 'not_setup_owner');
  }
  return ownership;
}

/**
 * 登录后是否强制进初始化页：未完成且当前身份就是 owner 时返回 true。
 *
 * 名单非空时只强制管理员，避免把普通学生带到他们无权进入的页面；
 * 名单为空（全新部署）时保持原行为：第一个登录的人被带到 /setup 并在这里认领 owner。
 * 网关不可用时返回 false，登录照常进行，不把初始化故障放大成登录故障。
 */
export async function shouldForceSetup(subject: string, email: string): Promise<boolean> {
  try {
    if ((await hasAdminRoster()) && !(await resolvePortalAdmin({ sub: subject, email }))) {
      return false;
    }
    const ownership = await resolveOwner(subject);
    return !ownership.completed && ownership.isOwner;
  } catch {
    return false;
  }
}
