/**
 * 成员账号的纯业务规则：成员名生成、状态迁移、可提交/可重试判定、联系方式校验。
 *
 * 这里不碰 IO、不读配置，全部是可直接断言的纯函数——接口层与页面层共用同一套判定，
 * 避免「页面允许点、接口却拒绝」的两套逻辑。
 */

import type { MemberApplication, MemberStatus } from './types';

/** 腾讯云成员名（同时作 AccountName）上限 */
export const MEMBER_NAME_MAX = 25;
/** 失败后再次提交的冷却时间，避免把门户当账号存在性探测器 */
export const SUBMIT_COOLDOWN_MS = 60_000;
/** `provisioning` 超过该时长才视为「已中断」，可被管理员重试 */
export const PROVISION_TIMEOUT_MS = 120_000;

/** 腾讯云允许的字符集：英文字母、数字、汉字与 +@&._[]-:, */
const ALLOWED_CHAR = /[\p{Script=Han}A-Za-z0-9+@&._[\]:,-]/u;
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const PHONE_PATTERN = /^\d{6,15}$/;
const COUNTRY_CODE_PATTERN = /^\d{1,4}$/;

/**
 * 合法状态迁移表；`active` 是终态。
 *
 * `provisioning → pending` 只用于「中断单自救」：开通超过 120 秒视为进程中断，
 * 允许本人补填资料后重新排队，否则单据会永久卡在开通中。
 */
const TRANSITIONS: Record<MemberStatus, MemberStatus[]> = {
  pending: ['pending', 'provisioning', 'rejected'],
  provisioning: ['provisioning', 'pending', 'active', 'needs_email', 'needs_phone', 'failed'],
  // 删除只有一条正向路径：active → removing → deleted；
  // removing 允许回到 active，用于「云侧拒绝删除」时回滚，不留中间态。
  active: ['removing'],
  removing: ['removing', 'deleted', 'active'],
  // 记录保留，本人可以重新申请（沿用同一条单）
  deleted: ['pending'],
  needs_email: ['pending'],
  needs_phone: ['pending'],
  // 开通失败既可由管理员重试，也可由本人重新发起申请（回到 pending 重新审核）
  failed: ['provisioning', 'pending'],
  rejected: ['pending'],
};

/** 从 `school_id:user_id` 解析数字 user_id；格式不对直接抛。 */
export function parseUserId(sub: string): number {
  const [, raw] = (sub ?? '').split(':');
  const value = Number(raw);
  if (!raw || !Number.isInteger(value) || value <= 0) {
    throw new Error(`sub 格式应为 school_id:user_id，当前是 ${sub}`);
  }
  return value;
}

function sanitizeName(raw: string): string {
  let output = '';
  for (const char of raw.normalize('NFC')) {
    // 空格当分隔符：中文姓名里常见「张 三」这种录入
    if (/\s/.test(char)) {
      output += '-';
      continue;
    }
    if (ALLOWED_CHAR.test(char)) output += char;
  }
  return output.replace(/-+/g, '-').replace(/^-|-$/g, '');
}

/**
 * 生成成员名 `{姓名}-{user_id}`。
 *
 * 超长时截断姓名而不是截断 user_id：user_id 是唯一性来源，砍掉后就无法对应回申请人。
 */
export function buildMemberName(name: string, userId: number): string {
  const suffix = `-${userId}`;
  const cleaned = sanitizeName(name ?? '');
  if (!cleaned) return String(userId).slice(0, MEMBER_NAME_MAX);

  const budget = MEMBER_NAME_MAX - suffix.length;
  if (budget <= 0) return suffix.slice(-MEMBER_NAME_MAX);

  const head = Array.from(cleaned)
    .slice(0, budget)
    .join('')
    .replace(/-$/, '');
  return `${head}${suffix}`;
}

/**
 * 是否能（重新）发起申请：一个人同一时间只能有一张未结束的单。
 *
 * `failed` 也允许本人重提：开通失败多半要靠本人换联系方式或部门，只让管理员重试
 * 会把老师卡在「等待处理」里；重提后回到 `pending`，仍要管理员再审核一次。
 */
export function canSubmit(app: MemberApplication | null | undefined): boolean {
  if (!app) return true;
  return (
    app.status === 'needs_email' ||
    app.status === 'needs_phone' ||
    app.status === 'rejected' ||
    app.status === 'failed' ||
    // 账号被删除后允许重新申请：单子保留，走同一条记录
    app.status === 'deleted'
  );
}

/**
 * 管理员是否能删除成员账号。
 *
 * 只有 `active` 可删：其余状态没有云侧账号可移除（pending/rejected 撤销申请是另一件事），
 * `removing` 表示已有人在删，交给幂等逻辑处理，不重复入口。
 */
export function canDelete(app: MemberApplication): boolean {
  return app.status === 'active';
}

/** `removing` 是否是中断的删除（超过阈值可重试补正）。 */
export function isRemoveInterrupted(app: MemberApplication, now: number = Date.now()): boolean {
  if (app.status !== 'removing') return false;
  const started = Date.parse(app.removingStartedAt ?? app.updatedAt);
  if (!Number.isFinite(started)) return true;
  return now - started > PROVISION_TIMEOUT_MS;
}

/**
 * `provisioning` 是否已超过阈值、可视为进程中断。
 *
 * 缺 `provisioningStartedAt` 时退回 `updatedAt`：否则「历史/手改数据缺时间戳 + 部门为空」
 * 会出现本人不能改、管理员也不能通过的永久死锁（D6 要消除的正是这种情况）。
 */
export function isProvisionInterrupted(
  app: MemberApplication,
  now: number = Date.now()
): boolean {
  if (app.status !== 'provisioning') return false;
  const started = Date.parse(app.provisioningStartedAt ?? app.updatedAt);
  if (!Number.isFinite(started)) return false;
  return now - started > PROVISION_TIMEOUT_MS;
}

/**
 * 本人是否能改资料（含部门）：`failed` 走完整重新申请（可改部门），不从这里进。
 * `provisioning` 仅在超过阈值、可判定为中断时放行——正常开通中不允许改。
 */
export function canEditContact(app: MemberApplication, now: number = Date.now()): boolean {
  return (
    app.status === 'pending' ||
    app.status === 'needs_email' ||
    app.status === 'needs_phone' ||
    app.status === 'rejected' ||
    isProvisionInterrupted(app, now)
  );
}

/** 管理员是否能「重试开通」：失败可重试，开通中需等超过阈值。 */
export function canRetry(app: MemberApplication, now: number = Date.now()): boolean {
  if (app.status === 'failed') return true;
  if (app.status !== 'provisioning') return false;
  // 历史数据可能没有时间戳：按可重试处理，避免卡死
  if (!app.provisioningStartedAt) return true;
  return now - Date.parse(app.provisioningStartedAt) > PROVISION_TIMEOUT_MS;
}

/** 距离可以再次提交还剩多少毫秒；0 表示不受限。 */
export function cooldownRemainingMs(
  app: MemberApplication | null | undefined,
  now: number = Date.now()
): number {
  if (!app?.lastAttemptAt) return 0;
  // 账号被管理员删除后允许立即重新申请：冷却的目的是防止拿门户当「账号存在性探测器」，
  // 而删除是管理员的主动动作，本人此时重提不构成探测。
  if (app.status === 'deleted') return 0;
  const elapsed = now - Date.parse(app.lastAttemptAt);
  if (!Number.isFinite(elapsed)) return 0;
  return Math.max(0, SUBMIT_COOLDOWN_MS - elapsed);
}

export function assertTransition(from: MemberStatus, to: MemberStatus): void {
  if (!TRANSITIONS[from]?.includes(to)) {
    throw new Error(`申请单不能从 ${from} 变成 ${to}`);
  }
}

export type ContactInput = {
  email: string;
  countryCode: string;
  phone: string;
};

export type ContactValidation = {
  ok: boolean;
  errors: Partial<Record<keyof ContactInput, string>>;
};

export function validateContact(input: ContactInput): ContactValidation {
  const errors: ContactValidation['errors'] = {};
  const email = (input.email ?? '').trim();
  const phone = (input.phone ?? '').trim();
  const countryCode = (input.countryCode ?? '').trim();

  if (!email) errors.email = '请填写邮箱';
  else if (!EMAIL_PATTERN.test(email)) errors.email = '邮箱格式不正确';

  if (!phone) errors.phone = '请填写手机号';
  else if (!PHONE_PATTERN.test(phone)) errors.phone = '手机号应为 6-15 位纯数字';

  if (!countryCode) errors.countryCode = '请填写国际区号';
  else if (!COUNTRY_CODE_PATTERN.test(countryCode)) errors.countryCode = '国际区号必须是数字';

  return { ok: Object.keys(errors).length === 0, errors };
}
