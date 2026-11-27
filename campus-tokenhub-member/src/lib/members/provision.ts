/**
 * 开通编排：解析部门 → 建号 → 绑邮箱手机 → 校验绑定结果 → 归入状态。
 *
 * 四条铁律：
 * 1. **不删除任何腾讯云账号**：失败只记录状态，清理走控制台人工操作。
 * 2. **不接管他人账号**：重名回查时必须 `Remark === portal:<sub>` 才复用 uin。
 * 3. **错误码要分得清**：`EmailAlreadyUsed`（邮箱属别人）与 `MemberEmailExist`
 *    （本成员已绑过）走不同分支，否则会与手机号失败互相触发。
 * 4. **部门先于建号**：部门解析/创建失败时一个成员号都不建，避免账号落在错部门。
 */

import { audit } from '@/lib/audit';
import type { MemberApplication, MemberStatus } from '@/lib/members/types';
import { DepartmentError, resolveDepartment, type ResolveDepartmentResult } from './departments';
import {
  MEMBER_EMAIL_EXISTS_CODES,
  messageForCode,
  statusForBindCode,
} from '@/lib/tencent/errors';
import { TencentApiError, type OrganizationClient } from '@/lib/tencent/organization';

export type ProvisionOutcome = {
  status: MemberStatus;
  uin: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  requestId: string | null;
  /** 部门解析结果：失败时为 null */
  resolvedNodeId: number | null;
  resolvedNodePath: string | null;
  /** 本次审核新建的部门层级（按创建顺序），用于写进事件轨迹 */
  createdDepartments: string[];
};

export type ProvisionInput = {
  app: MemberApplication;
  client: OrganizationClient;
  policyType: string;
  permissionIds: number[];
  /** 配置的根节点；0 / 缺省表示自动推断 */
  rootNodeId?: number;
  /** 测试注入时钟（部门阶段预算） */
  now?: () => number;
  /** 测试替换；默认写 stdout 审计 */
  audit?: typeof audit;
};

/** 建号可能已经在腾讯云侧生效的错误：先回查再决定 */
const AMBIGUOUS_CREATE_CODES = new Set(['NetworkError', 'Timeout']);

function errorCodeOf(error: unknown): string {
  if (error instanceof TencentApiError) return error.code;
  if (error instanceof DepartmentError) return error.code;
  return 'UnknownError';
}

function requestIdOf(error: unknown): string {
  if (error instanceof TencentApiError) return error.requestId;
  if (error instanceof DepartmentError) return error.requestId;
  return '';
}

async function safeFind(
  client: OrganizationClient,
  name: string
): Promise<{ uin: string; remark: string } | null> {
  try {
    return await client.findMemberByName(name);
  } catch {
    // 回查失败按「查不到」处理：宁可让管理员重试，也不猜
    return null;
  }
}

export async function provisionApplication(input: ProvisionInput): Promise<ProvisionOutcome> {
  const { app, client, policyType, permissionIds } = input;
  const emit = input.audit ?? audit;
  // 归属标记：腾讯云成员无法删除，靠它判断「同名成员是不是本单建的」
  const remark = `portal:${app.applicantSub}`;

  let resolved: ResolveDepartmentResult | null = null;

  const finish = (
    outcome: Omit<ProvisionOutcome, 'resolvedNodeId' | 'resolvedNodePath' | 'createdDepartments'>
  ): ProvisionOutcome => {
    const withResolved: ProvisionOutcome = {
      ...outcome,
      resolvedNodeId: resolved?.nodeId ?? null,
      resolvedNodePath: resolved?.path ?? null,
      createdDepartments: resolved?.created ?? [],
    };
    emit('member.provision', {
      actor_external_id: app.applicantSub,
      target: withResolved.uin ?? app.memberName,
      result: withResolved.status,
      // 原始错误码只进审计，页面对老师只显示中文
      detail: withResolved.errorCode,
    });
    return withResolved;
  };

  const failed = (
    code: string,
    message: string,
    requestId = '',
    uin: string | null = null
  ): ProvisionOutcome => finish({ status: 'failed', uin, errorCode: code, errorMessage: message, requestId });

  // ---------------------------------------------------------------- 部门
  try {
    resolved = await resolveDepartment({
      segments: app.departmentPath.split('/'),
      client,
      rootNodeId: input.rootNodeId ?? 0,
      now: input.now,
    });
  } catch (error) {
    const code = errorCodeOf(error);
    return failed(code, messageForCode(code), requestIdOf(error));
  }

  if (resolved.created.length > 0 || resolved.multipleRoots) {
    emit('member.department.create', {
      actor_external_id: app.applicantSub,
      target: resolved.path,
      result: resolved.created.length > 0 ? 'created' : 'root_selected',
      detail: resolved.created.length > 0
        ? resolved.created.join('/')
        : `multiple roots, picked ${resolved.rootNodeId}`,
    });
  }

  // ---------------------------------------------------------------- 建号
  let uin = '';
  let requestId = '';

  try {
    const created = await client.createMember({
      name: app.memberName,
      accountName: app.memberName,
      nodeId: resolved.nodeId,
      policyType,
      permissionIds,
      remark,
    });
    uin = created.uin;
    requestId = created.requestId;
  } catch (error) {
    const code = errorCodeOf(error);
    const requestIdFromError = requestIdOf(error);

    const reused = await tryReuseExisting(client, app.memberName, remark);
    if (reused) {
      uin = reused.uin;
      requestId = requestIdFromError;
    } else {
      // 网络异常 / 超时也走这里：回查没命中才认定失败，避免重复建号。
      // 结果不确定的码（超时/网络）提示语要说明「可能已创建」，不能让学生直接重新提交
      return failed(
        code,
        AMBIGUOUS_CREATE_CODES.has(code)
          ? '创建结果未确认（可能已创建），请稍后由管理员重试开通'
          : messageForCode(code),
        requestIdFromError
      );
    }
  }

  // 建号成功却没给 Uin：按名回查一次，拿不到就只能让管理员核对
  if (!uin) {
    const found = await safeFind(client, app.memberName);
    uin = found?.uin ?? '';
  }
  if (!uin) {
    return failed(
      'MissingUin',
      '创建接口未返回 Uin，请到腾讯云控制台核对账号是否已创建',
      requestId
    );
  }

  // ---------------------------------------------------------------- 绑邮箱 + 手机
  try {
    const bound = await client.bindEmail({
      uin,
      email: app.email,
      countryCode: app.countryCode,
      phone: app.phone,
    });
    requestId = bound.requestId || requestId;
  } catch (error) {
    const code = errorCodeOf(error);
    const requestIdFromError = requestIdOf(error) || requestId;

    // 本成员已绑过邮箱：回查实际状态，已绑好就算成功，避免误判成「换邮箱」
    if (MEMBER_EMAIL_EXISTS_CODES.has(code)) {
      const bindStatus = await readBindStatus(client, uin);
      if (bindStatus === 'Success' || bindStatus === 'Valid') {
        return finish({
          status: 'active',
          uin,
          errorCode: null,
          errorMessage: null,
          requestId: requestIdFromError,
        });
      }
      return failed(code, messageForCode(code), requestIdFromError, uin);
    }

    return finish({
      status: statusForBindCode(code),
      uin,
      errorCode: code,
      errorMessage: messageForCode(code),
      requestId: requestIdFromError,
    });
  }

  // ---------------------------------------------------------------- 校验绑定结果
  const bindStatus = await readBindStatus(client, uin);
  if (bindStatus === 'Failed') {
    return failed(
      'BindFailed',
      '邮箱绑定未通过腾讯云校验，请稍后由管理员重试',
      requestId,
      uin
    );
  }
  if (bindStatus === 'unknown') {
    // 回查失败不能当成「绑定成功」：否则页面提示激活邮件已发送，老师实际收不到。
    // 落 needs_email（可重试），由管理员/本人再触发一次。
    return finish({
      status: 'needs_email',
      uin,
      errorCode: 'BindUnverified',
      errorMessage: '未能确认邮箱绑定状态，请稍后由管理员重试',
      requestId,
    });
  }

  return finish({
    status: 'active',
    uin,
    errorCode: null,
    errorMessage: null,
    requestId,
  });
}

async function readBindStatus(client: OrganizationClient, uin: string): Promise<string> {
  try {
    const state = await client.getEmailBindStatus(uin);
    return state.bindStatus;
  } catch {
    // 回查失败返回 unknown（不是空串）：调用方据此落可重试状态，而不是判 active
    return 'unknown';
  }
}

/**
 * 重名 / 超时后的归属判定：只有 `Remark` 等于本单标记才复用，否则视为他人账号。
 * 这是「不接管别人账号」的唯一依据——腾讯云成员无法删除，接管后果不可逆。
 */
async function tryReuseExisting(
  client: OrganizationClient,
  name: string,
  remark: string
): Promise<{ uin: string } | null> {
  const found = await safeFind(client, name);
  if (!found || !found.uin) return null;
  if (found.remark !== remark) return null;
  return { uin: found.uin };
}
