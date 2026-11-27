/**
 * 申请单状态 → 页面文案与可执行动作。
 *
 * 文案只说老师能行动的事：不暴露腾讯云错误码、RequestId，也不断言
 * 「该邮箱已在腾讯云注册」（那等于把门户变成账号存在性探测器）。
 */

import { canEditContact, canRetry, isProvisionInterrupted } from './rules';
import type { MemberAdminCandidate, MemberApplication, MemberStatus } from './types';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export type StatusView = {
  title: string;
  description: string;
  tone: StatusTone;
  canEditContact: boolean;
  canRetry: boolean;
};

type Copy = { title: string; tone: StatusTone; description: (app: MemberApplication) => string };

const COPY: Record<MemberStatus, Copy> = {
  removing: {
    title: '正在删除',
    tone: 'warning',
    description: () =>
      '管理员已发起删除，正在通知腾讯云移除该成员账号。通常几秒内完成；若长时间停在这里，管理员可以重试。',
  },
  deleted: {
    title: '已删除',
    tone: 'danger',
    description: () =>
      '该成员账号已从腾讯云组织移除，账号下的密钥与资源不再可用。如需重新开通，可以在下方重新提交申请。',
  },
  pending: {
    title: '待审核',
    tone: 'info',
    description: () =>
      '申请已提交，管理员审核通过后会自动为你开通腾讯云账号。审核期间如发现资料填错，可点击右上角「修改」更新后重新提交。',
  },
  provisioning: {
    title: '开通中',
    tone: 'info',
    description: (app) =>
      isProvisionInterrupted(app)
        ? '这次开通已中断（超过 2 分钟没有完成）。请在下方确认/补填资料后重新提交，管理员会再审核一次。'
        : '正在为你开通腾讯云成员账号，通常几秒内完成。若长时间停滞，管理员可以手动重试。',
  },
  active: {
    title: '已开通',
    tone: 'success',
    description: (app) =>
      `腾讯云已向 ${app.email} 发送激活邮件，请查收并点击邮件中的链接完成激活，之后即可登录腾讯云控制台。${
        app.uin ? `成员账号 Uin：${app.uin}。` : ''
      }`,
  },
  needs_email: {
    title: '邮箱不可用',
    tone: 'warning',
    description: () =>
      '当前邮箱暂时无法用于开通，请换一个未使用过的邮箱后重新提交，管理员会再审核一次。',
  },
  needs_phone: {
    title: '手机号不可用',
    tone: 'warning',
    description: () =>
      '当前手机号绑定数量已达上限，请换一个手机号后重新提交，管理员会再审核一次。',
  },
  failed: {
    title: '开通失败',
    tone: 'danger',
    description: () =>
      '这次开通没有成功。你可以在下方修改资料后重新提交申请，管理员会重新审核；若多次失败，请联系管理员排查。',
  },
  rejected: {
    title: '已驳回',
    tone: 'danger',
    description: (app) =>
      app.reviewNote
        ? `管理员驳回了这次申请，理由：${app.reviewNote}。按理由修改资料后可重新提交。`
        : '管理员驳回了这次申请，修改资料后可重新提交。',
  },
};

export function describeStatus(app: MemberApplication, now: number = Date.now()): StatusView {
  const copy = COPY[app.status];
  return {
    title: copy.title,
    description: copy.description(app),
    tone: copy.tone,
    canEditContact: canEditContact(app, now),
    canRetry: canRetry(app, now),
  };
}

/**
 * 合并管理员候选：搜索只返回子集，名单项常在结果里但没有姓名，
 * 直接覆盖会让列表退化成「姓名未同步」，所以按字段取更优值。
 */
export function mergeAdminCandidates(
  current: MemberAdminCandidate[],
  incoming: MemberAdminCandidate[]
): MemberAdminCandidate[] {
  const merged = new Map(current.map((item) => [item.sub, item]));

  for (const item of incoming) {
    const previous = merged.get(item.sub);
    if (!previous) {
      merged.set(item.sub, item);
      continue;
    }
    const previousNamed = previous.name !== previous.sub;
    merged.set(item.sub, {
      ...item,
      name: previousNamed ? previous.name : item.name,
      email: previous.email ?? item.email,
    });
  }

  return [...merged.values()];
}
