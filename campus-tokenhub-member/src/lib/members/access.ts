/**
 * 成员账号功能的访问控制与前置条件。
 *
 * 管理员名单的唯一来源是共享层 `portal_shared.admins`（见 `lib/admin/roster.ts`），
 * 由 `/admins` 页面维护。判定链只有两条：`本地引导账号 → 共享名单`，
 * 名单为空时由首登认领写入（不回落 onboarding owner，也没有邮箱白名单）
 * （最后一步发生在登录签发路径上，见 `auth/admin.ts` 的 `claimFirstAdminOnLogin`）。
 *
 * 名单是单一角色——全局管理员：能审核成员、进设置，以及维护名单本身。
 * 因此本文件只暴露 **一个** 判定函数 `isMemberAdmin` 与它的断言版，不按层级拆多个同义函数。
 */

import { ApiError } from '@/lib/api/guard';
import { getConfig } from '@/lib/config';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import type { SessionPayload } from '@/lib/auth/session';

/**
 * 是否管理员——**成员站唯一的权限判定入口**。
 *
 * 名单是单一角色（全局管理员）：能审核成员、进设置、维护名单本身。所以这里不按
 * 「审核员 / 只读管理员」这类层级拆函数——名字里带语义层级、实现却完全相同，
 * 将来引入角色分级时最容易改漏其中一个（曾经并存过 `isPortalAdmin` /
 * `canManageMemberAdmins` 两个同义函数，现已合并到这里）。
 *
 * 判定口径完全交给 `resolvePortalAdmin`：本地引导账号 → 共享名单 → 邮箱白名单，
 * 名单为空时由登录签发路径上的 `claimFirstAdminOnLogin` 完成首登认领。
 */
export async function isMemberAdmin(session: SessionPayload): Promise<boolean> {
  return resolvePortalAdmin(session);
}

/** 断言版：接口层用，非管理员一律 403（不做「部分放行」）。 */
export async function requireMemberAdmin(session: SessionPayload): Promise<void> {
  if (!(await isMemberAdmin(session))) {
    throw new ApiError(403, '成员账号审核仅对管理员开放', 'not_member_admin');
  }
}

/**
 * 成员组织是否可用：凭据齐全 **且** 最近一次探测没有失败。
 *
 * 探测失败仍然放着可用，等于让老师提交后才在腾讯云那边报错——这里直接按「未配置」处理。
 */
export async function isMemberAccountConfigured(): Promise<boolean> {
  const cfg = getConfig();
  if (cfg.memberAccount.provider === 'mock') return true;
  if (!cfg.tencentCloud.secretId || !cfg.tencentCloud.secretKey) return false;

  const { readStoredConfig, groupStatus } = await import('@/lib/config/store');
  return groupStatus(await readStoredConfig(), 'tencent') !== 'failed';
}

export async function assertMemberReady(): Promise<void> {
  const cfg = getConfig();
  if (!cfg.portal.publicBaseUrl) {
    throw new ApiError(503, '门户对外地址未配置，暂时无法提交', 'not_configured');
  }
  if (!(await isMemberAccountConfigured())) {
    throw new ApiError(503, '成员账号申请暂未开放，请联系管理员', 'not_configured');
  }
}
