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
import { assertMemberReady } from '@/lib/members/access';
import { normalizeDepartmentPath } from '@/lib/members/department-path';
import { canEditContact, validateContact } from '@/lib/members/rules';
import { findById, mutateStore } from '@/lib/members/store';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 本人修改联系方式。
 *
 * 三种场景共用这一个入口：`pending` 期间改错字、`needs_email` / `needs_phone` /
 * `rejected` 改完重新排队、开通中断后补资料，都回到 pending 重新审核。
 * 每次修改都会递增 revision，旧邮箱写进事件轨迹，管理员可据此区分「修改后重新提交」。
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await assertMemberReady();

    const { id } = await context.params;
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

    // 部门可选：只改联系方式时不动部门；传了就按同一套规则校验
    const rawDepartment = body.departmentPath;
    let departmentPath: string | null = null;
    if (rawDepartment !== undefined) {
      const department = normalizeDepartmentPath(String(rawDepartment));
      if (!department.ok) {
        throw new ApiError(
          400,
          department.errors[0]?.message ?? '部门路径不正确',
          'invalid_department'
        );
      }
      departmentPath = department.path;
    }

    const updated = await mutateStore((apps) => {
      const app = findById(apps, id);
      // 他人申请单一律按不存在处理，不暴露该单是否真的存在
      if (!app || app.applicantSub !== session.sub) {
        throw new ApiError(404, '申请单不存在', 'not_found');
      }

      if (app.status === 'active') {
        throw new ApiError(409, '成员账号已开通，无法再修改资料', 'already_active');
      }
      // 开通中默认不可改；只有超过 120 秒、可判定为中断时才放行（中断单自救）
      if (!canEditContact(app)) {
        if (app.status === 'provisioning') {
          throw new ApiError(409, '账号正在开通中，请稍后再试', 'provision_in_progress');
        }
        throw new ApiError(409, '当前状态不允许修改资料', 'not_editable');
      }

      const now = new Date().toISOString();
      const from = app.status;
      const previousEmail = app.email;

      Object.assign(app, {
        email: contact.email,
        countryCode: contact.countryCode,
        phone: contact.phone,
        // 部门可能变了：旧的解析结果作废，等下次审核重新落
        ...(departmentPath === null
          ? {}
          : { departmentPath, resolvedNodeId: null, resolvedNodePath: null }),
        // pending 期间纠错、needs_* / rejected / 中断单改完重新排队，都回到 pending 重新审核；
        // 无论哪种，只要本人改了资料就算一次修订，revision 递增供管理员区分
        status: 'pending',
        errorCode: null,
        errorMessage: null,
        revision: (app.revision ?? 0) + 1,
        updatedAt: now,
      });

      app.events.push({
        at: now,
        from,
        to: 'pending',
        actor: 'user',
        note:
          from === 'provisioning'
            ? `开通已中断，本人补填资料（原邮箱 ${previousEmail}）`
            : `本人修改资料后重新提交（原邮箱 ${previousEmail}）`,
      });

      return app;
    });

    return jsonNoStore({ application: updated });
  } catch (error) {
    return jsonError(error);
  }
}
