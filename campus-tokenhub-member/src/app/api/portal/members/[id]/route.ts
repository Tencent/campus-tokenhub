import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  jsonNoStore,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireMemberAdmin } from '@/lib/members/access';
import { assertTransition, canDelete, isRemoveInterrupted } from '@/lib/members/rules';
import { findById, mutateStore, readStore } from '@/lib/members/store';
import { getOrganizationClient } from '@/lib/tencent/factory';
import { TencentApiError } from '@/lib/tencent/organization';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 删除成员账号：从腾讯云组织移除该子账号（不可逆）。
 *
 * 与开通同样的并发策略——**先把状态改成 `removing` 再调云**：
 * 第二个请求看到「删除中」直接返回当前状态，不会重复调用 DeleteOrganizationMembers。
 *
 * 失败一律回滚到 `active` 并把云侧原文留在 `deleteError`：
 * 删不掉（例如成员名下有未结清账单）必须让管理员看见原因、可以再试，
 * 而不是把记录卡在一个「既不是活着也不是死了」的中间态。
 */
export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertMethod(request, ['DELETE']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireMemberAdmin(session);
    const { id } = await context.params;

    const apps = await readStore();
    const app = findById(apps, id);
    if (!app) throw new ApiError(404, '申请单不存在', 'not_found');

    // 管理员也可能给自己申请过成员账号；一个误点就能删掉自己的账号，直接拦住
    if (app.applicantSub === session.sub) {
      throw new ApiError(403, '不能删除自己的成员账号，请让其他管理员操作', 'cannot_delete_self');
    }
    if (!app.uin) {
      throw new ApiError(409, '该申请还没有对应的腾讯云账号', 'no_uin');
    }

    // 已有人在删且未超时：直接返回进行中，不重复调云
    if (app.status === 'removing' && !isRemoveInterrupted(app)) {
      return jsonNoStore({ application: app, inProgress: true });
    }

    // removing 超时（上一次删除中断）允许重试，其余必须是 active
    if (app.status !== 'removing' && !canDelete(app)) {
      throw new ApiError(409, '只有「已开通」的成员账号可以删除', 'not_removable');
    }

    const startedAt = new Date().toISOString();
    const claimed = await mutateStore((list) => {
      const target = findById(list, id);
      if (!target) return null;
      const from = target.status;
      assertTransition(from, 'removing');
      target.status = 'removing';
      target.removingStartedAt = startedAt;
      target.deleteError = null;
      target.updatedAt = startedAt;
      target.events.push({
        at: startedAt,
        from,
        to: 'removing',
        actor: 'admin',
        note: from === 'active' ? '管理员发起删除' : '上一次删除中断，管理员重试',
      });
      return { ...target, events: [...target.events] };
    });

    if (!claimed) {
      const current = await readStore();
      const latest = findById(current, id);
      if (!latest) throw new ApiError(404, '申请单不存在', 'not_found');
      return jsonNoStore({ application: latest, superseded: true });
    }

    try {
      const result = await getOrganizationClient().deleteMember(app.uin);

      const finished = await mutateStore((list) => {
        const target = findById(list, id);
        // 期间被别的操作改走：丢弃回写，返回真实状态
        if (!target || target.status !== 'removing') return null;
        const at = new Date().toISOString();
        target.status = 'deleted';
        target.deletedAt = at;
        target.deleteRequestId = result.requestId || null;
        target.deleteError = null;
        target.updatedAt = at;
        target.events.push({
          at,
          from: 'removing',
          to: 'deleted',
          actor: 'admin',
          note: result.alreadyGone
            ? '云侧已无此成员，按删除成功处理'
            : result.pendingReview
              ? `已提交销号申请（UIN ${target.uin}），腾讯云审核中`
              : `已删除账号 UIN ${target.uin}`,
        });
        return { ...target, events: [...target.events] };
      });

      audit('member.delete', {
        actor_external_id: session.sub,
        target: app.memberName,
        result: 'success',
        ip: clientIp(request.headers),
        ua: request.headers.get('user-agent'),
      });

      if (!finished) {
        const current = await readStore();
        const latest = findById(current, id);
        if (!latest) throw new ApiError(404, '申请单不存在', 'not_found');
        console.warn('[members] 删除结果已过期，丢弃回写', { id, status: latest.status });
        return jsonNoStore({ application: latest, superseded: true });
      }

      return jsonNoStore({
        application: finished,
        alreadyGone: result.alreadyGone,
        pendingReview: result.pendingReview,
      });
    } catch (error) {
      const message =
        error instanceof TencentApiError ? error.message : '删除失败，请稍后重试';
      const at = new Date().toISOString();

      // 回滚到 active：保留原因，管理员可再试；不把账号留在「删除中」
      await mutateStore((list) => {
        const target = findById(list, id);
        if (!target || target.status !== 'removing') return null;
        target.status = 'active';
        target.removingStartedAt = null;
        target.deleteError = message;
        target.updatedAt = at;
        target.events.push({
          at,
          from: 'removing',
          to: 'active',
          actor: 'system',
          note: `删除失败已回滚：${message}`,
        });
        return { ...target, events: [...target.events] };
      });

      throw new ApiError(502, message, 'delete_failed');
    }
  } catch (error) {
    return jsonError(error);
  }
}
