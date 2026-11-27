/**
 * 腾讯云错误码 → 面向老师的中文提示。
 *
 * 只保留门户确实会遇到的部分；未登记的错误码按前缀给兜底文案，
 * 管理员在审核详情里仍能看到原始 code 与 RequestId。
 */

import type { MemberStatus } from '@/lib/members/types';

export const EMAIL_TAKEN_CODES = new Set([
  'FailedOperation.EmailAlreadyUsed',
  'FailedOperation.CheckMailAccount',
]);

/** 本成员已绑定过邮箱：不能按「换邮箱」处理，否则会与手机号互相触发 */
export const MEMBER_EMAIL_EXISTS_CODES = new Set(['FailedOperation.MemberEmailExist']);

export const PHONE_LIMIT_CODES = new Set([
  'LimitExceeded.PhoneNumBound',
  'FailedOperation.CheckAccountPhoneBindLimit',
]);

const HINTS: Record<string, string> = {
  'FailedOperation.EmailAlreadyUsed': '该邮箱已注册过其他腾讯云账号，请换一个未使用过的邮箱',
  'FailedOperation.MemberEmailExist': '该账号已绑定过邮箱，请联系管理员在控制台调整',
  'FailedOperation.CheckMailAccount': '邮箱校验暂时失败，请稍后重试',
  'LimitExceeded.PhoneNumBound': '该手机号绑定的账号数已达上限，请换一个手机号',
  'FailedOperation.CheckAccountPhoneBindLimit': '该手机号绑定的账号数已达上限，请换一个手机号',
  'FailedOperation.OrganizationMemberNameUsed': '成员名已被占用，请联系管理员核对',
  'FailedOperation.MemberNameUsed': '成员名已被占用，请联系管理员核对',
  'LimitExceeded.OrganizationMemberOverLimit': '组织成员数已达上限，请联系管理员',
  'LimitExceeded.CreateMemberOverLimit': '创建成员过于频繁，请联系管理员稍后重试',
  'FailedOperation.OrganizationNodeNotExist': '部门节点不存在，请重新选择',
  'ResourceNotFound.OrganizationNodeNotExist': '部门节点不存在，请重新选择',
  'FailedOperation.OrganizationNodeNameUsed': '部门名与腾讯云已有部门冲突，请管理员到腾讯云控制台查看同名节点后驳回',
  'LimitExceeded.NodeDepthExceedLimit': '部门层级超出腾讯云上限，请减少层级后重新提交',
  'LimitExceeded.NodeExceedLimit': '部门数量已达腾讯云上限，请联系管理员',
  department_root_missing: '无法识别腾讯云组织根节点，请联系管理员核对凭据',
  department_empty: '请至少填写一级部门',
  department_conflict: '部门名与腾讯云已有部门冲突，请管理员到腾讯云控制台查看同名节点后驳回',
  department_tree_too_large: '组织节点过多，暂时无法自动创建部门，请联系管理员',
  department_timeout: '部门处理超时，请稍后重试',
  department_failed: '部门处理失败，请稍后重试',
  'FailedOperation.OrganizationPermissionIllegal': '财务权限配置不合法，请联系管理员',
  'ResourceNotFound.OrganizationNotExist': '门户凭据不属于集团管理账号，请联系管理员',
  'FailedOperation.OperationForbidden': '操作被腾讯云拒绝，请联系管理员核对',
  'UnsupportedOperation.OperationForbidden': '操作被腾讯云拒绝，请联系管理员核对',
  'AuthFailure.SecretIdNotFound': '门户凭据异常，请联系管理员',
  'AuthFailure.SignatureFailure': '门户凭据异常，请联系管理员',
  UnauthorizedOperation: '门户凭据权限不足，请联系管理员',
  Timeout: '腾讯云响应超时，请稍后重试',
  NetworkError: '无法连接腾讯云，请稍后重试',
  not_configured: '成员账号申请暂未开放，请联系管理员',
};

/** 未登记错误码按前缀兜底 */
const PREFIX_HINTS: { prefix: string; hint: string }[] = [
  { prefix: 'AuthFailure', hint: '门户凭据异常，请联系管理员' },
  { prefix: 'UnauthorizedOperation', hint: '门户凭据权限不足，请联系管理员' },
  { prefix: 'LimitExceeded', hint: '已触发腾讯云配额或频率上限，请联系管理员' },
  { prefix: 'InvalidParameter', hint: '部门名不符合腾讯云要求，请修改后重试' },
  { prefix: 'FailedOperation', hint: '腾讯云操作失败，请联系管理员核对' },
  { prefix: 'InternalError', hint: '腾讯云内部错误，请稍后重试' },
  { prefix: 'UnsupportedOperation', hint: '该操作被腾讯云拒绝，请联系管理员' },
];

export function messageForCode(code: string | null | undefined): string {
  if (!code) return '开通失败，请联系管理员重试';
  const exact = HINTS[code];
  if (exact) return exact;
  const byPrefix = PREFIX_HINTS.find(
    (item) => code === item.prefix || code.startsWith(`${item.prefix}.`)
  );
  return byPrefix?.hint ?? '开通失败，请联系管理员重试';
}

/**
 * 绑定失败时的状态归属。
 *
 * `MemberEmailExist` 故意不归到 `needs_email`：一次绑定同时带邮箱与手机，
 * 若手机号失败而邮箱已落到本单 uin，老师改手机号重提时会被判成「换邮箱」，
 * 与 `needs_phone` 反复互相触发。这类情况交给调用方回查 BindStatus 决定。
 */
export function statusForBindCode(code: string): MemberStatus {
  if (EMAIL_TAKEN_CODES.has(code)) return 'needs_email';
  if (PHONE_LIMIT_CODES.has(code)) return 'needs_phone';
  return 'failed';
}
