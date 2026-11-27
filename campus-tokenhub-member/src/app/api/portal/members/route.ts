import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  jsonNoStore,
  requireSession,
} from '@/lib/api/guard';
import { readJsonObject as readBody } from '@/lib/api/body';
import { audit, clientIp } from '@/lib/audit';
import { assertMemberReady } from '@/lib/members/access';
import { normalizeDepartmentPath } from '@/lib/members/department-path';
import {
  buildMemberName,
  canSubmit,
  cooldownRemainingMs,
  parseUserId,
  validateContact,
  assertTransition,
} from '@/lib/members/rules';
import { findBySub, mutateStore, readStore } from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';

export const dynamic = 'force-dynamic';

/** 自己的申请单；没有就返回 null，页面据此渲染表单。 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['GET']);
    const session = await requireSession(request);
    const apps = await readStore();
    const app = findBySub(apps, session.sub) ?? null;

    return jsonNoStore({ application: app });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await assertMemberReady();

    const body = await readBody(request);
    const contact = {
      email: String(body.email ?? '').trim(),
      countryCode: String(body.countryCode ?? '86').trim(),
      phone: String(body.phone ?? '').trim(),
    };

    const validation = validateContact(contact);
    if (!validation.ok) {
      throw new ApiError(400, Object.values(validation.errors)[0] ?? '资料不完整', 'invalid_contact');
    }

    const apps = await readStore();
    const existing = findBySub(apps, session.sub);

    const cooldown = cooldownRemainingMs(existing);
    if (cooldown > 0) {
      throw new ApiError(
        429,
        `操作过于频繁，请 ${Math.ceil(cooldown / 1000)} 秒后再试`,
        'too_many_attempts'
      );
    }

    if (!canSubmit(existing)) {
      throw new ApiError(
        409,
        existing?.status === 'active' ? '成员账号已开通，无需重复申请' : '你已有一条申请正在处理',
        existing?.status === 'active' ? 'already_active' : 'application_exists'
      );
    }

    const department = normalizeDepartmentPath(String(body.departmentPath ?? ''));
    if (!department.ok) {
      throw new ApiError(
        400,
        department.errors[0]?.message ?? '部门路径不正确',
        'invalid_department'
      );
    }
    const departmentPath = department.path;

    let userId: number;
    try {
      userId = parseUserId(session.sub);
    } catch {
      throw new ApiError(403, '当前登录身份无法申请成员账号，请联系管理员', 'invalid_identity');
    }

    const memberName = existing?.memberName ?? buildMemberName(session.name || '', userId);
    const remark = String(body.remark ?? '').trim().slice(0, 100);

    const saved = await mutateStore((list) => {
      const target = findBySub(list, session.sub);
      const now = new Date().toISOString();

      if (target) {
        // 重提：沿用同一条记录，保留历史轨迹
        const from = target.status;
        assertTransition(from, 'pending');
        Object.assign(target, {
          email: contact.email,
          countryCode: contact.countryCode,
          phone: contact.phone,
          departmentPath,
          // 部门可能变了：旧的解析结果作废，等下次审核重新落
          resolvedNodeId: null,
          resolvedNodePath: null,
          remark,
          status: 'pending',
          errorCode: null,
          errorMessage: null,
          // 重新发起申请也算一次修订，管理员可据此区分是否改过资料
          revision: (target.revision ?? 0) + 1,
          updatedAt: now,
        });
        target.events.push({
          at: now,
          from,
          to: 'pending',
          actor: 'user',
          note: '修改资料后重新提交',
        });
        return target;
      }

      const created: MemberApplication = {
        id: randomUUID(),
        applicantSub: session.sub,
        applicantName: session.name || '',
        userId,
        memberName,
        email: contact.email,
        countryCode: contact.countryCode,
        phone: contact.phone,
        departmentPath,
        removingStartedAt: null,
        deletedAt: null,
        deleteRequestId: null,
        deleteError: null,
        resolvedNodeId: null,
        resolvedNodePath: null,
        remark,
        status: 'pending',
        uin: null,
        errorCode: null,
        errorMessage: null,
        tencentRequestId: null,
        reviewNote: null,
        reviewedBy: null,
        reviewedAt: null,
        provisioningStartedAt: null,
        lastAttemptAt: null,
        revision: 0,
        events: [{ at: now, from: null, to: 'pending', actor: 'user', note: '提交申请' }],
        createdAt: now,
        updatedAt: now,
      };
      list.push(created);
      return created;
    });

    audit('member.apply', {
      actor_external_id: session.sub,
      target: saved.memberName,
      result: 'pending',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return jsonNoStore({ application: saved }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
