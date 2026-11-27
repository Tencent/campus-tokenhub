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
import { requireMemberAdmin, assertMemberReady } from '@/lib/members/access';
import { provisionApplication } from '@/lib/members/provision';
import { assertTransition, canRetry } from '@/lib/members/rules';
import { findById, mutateStore, readStore } from '@/lib/members/store';
import { getConfig } from '@/lib/config';
import { getOrganizationClient } from '@/lib/tencent/factory';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const ACTIONS = new Set(['approve', 'reject', 'retry']);

/**
 * 审核：通过（同步开通）/ 驳回（必填理由）/ 重试开通。
 *
 * 防双击靠「先落 provisioning 再执行」：第二次进来的请求看到状态已经不是 pending，
 * 直接返回当前状态，不会重复建号；`provisioning` 超过阈值才允许重试。
 */
export async function POST(request: Request, context: RouteContext): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireMemberAdmin(session);
    await assertMemberReady();

    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? '').trim();
    if (!ACTIONS.has(action)) {
      throw new ApiError(400, '未知的审核动作', 'invalid_action');
    }

    const apps = await readStore();
    const existing = findById(apps, id);
    if (!existing) throw new ApiError(404, '申请单不存在', 'not_found');

    // ---------------------------------------------------------------- 驳回
    if (action === 'reject') {
      const note = String(body.note ?? '').trim();
      if (!note) throw new ApiError(400, '驳回需要填写理由', 'note_required');

      const rejected = await mutateStore((list) => {
        const app = findById(list, id);
        if (!app) throw new ApiError(404, '申请单不存在', 'not_found');
        if (app.status !== 'pending') {
          throw new ApiError(409, '只有待审核的申请可以驳回', 'not_reviewable');
        }

        const at = new Date().toISOString();
        Object.assign(app, {
          status: 'rejected',
          reviewNote: note,
          reviewedBy: session.sub,
          reviewedAt: at,
          updatedAt: at,
        });
        app.events.push({ at, from: 'pending', to: 'rejected', actor: 'admin', note });
        return app;
      });

      audit('member.review', {
        actor_external_id: session.sub,
        target: rejected.memberName,
        result: 'rejected',
        ip: clientIp(request.headers),
        ua: request.headers.get('user-agent'),
      });

      return jsonNoStore({ application: rejected });
    }

    // ---------------------------------------------------------------- 前置状态
    if ((action === 'approve' || action === 'retry') && !existing.departmentPath.trim()) {
      // 老数据/开发数据可能没有部门：先让申请人补填，避免带着空部门去建号
      throw new ApiError(409, '申请人尚未补填部门，暂时无法开通', 'department_missing');
    }

    if (action === 'approve' && existing.status !== 'pending') {
      // 幂等：已经在开通中 / 已开通 / 已失败，都直接回当前状态，不重复建号
      return jsonNoStore({ application: existing });
    }

    if (action === 'retry') {
      if (existing.status === 'provisioning' && !canRetry(existing)) {
        throw new ApiError(409, '账号正在开通中，请稍后再试', 'provision_in_progress');
      }
      if (!canRetry(existing)) {
        throw new ApiError(409, '当前状态不支持重试开通', 'not_retryable');
      }
    }

    // ---------------------------------------------------------------- CAS 进入 provisioning
    const started = await mutateStore((list) => {
      const app = findById(list, id);
      if (!app) return null;
      if (action === 'approve' && app.status !== 'pending') return null;
      if (action === 'retry' && !canRetry(app)) return null;
      // 锁内再校验一次：申请人可能在两步之间清掉了部门
      if (!app.departmentPath.trim()) {
        throw new ApiError(409, '申请人尚未补填部门，暂时无法开通', 'department_missing');
      }

      const at = new Date().toISOString();
      const from = app.status;
      assertTransition(from, 'provisioning');

      Object.assign(app, {
        status: 'provisioning',
        provisioningStartedAt: at,
        updatedAt: at,
        errorCode: null,
        errorMessage: null,
        reviewedBy: session.sub,
        reviewedAt: at,
      });
      app.events.push({
        at,
        from,
        to: 'provisioning',
        actor: 'admin',
        note: action === 'approve' ? '审核通过，开始开通' : '管理员重试开通',
      });
      return { ...app, events: [...app.events] };
    });

    if (!started) {
      // 并发下没抢到：返回当前真实状态
      const current = await readStore();
      const app = findById(current, id);
      if (!app) throw new ApiError(404, '申请单不存在', 'not_found');
      return jsonNoStore({ application: app });
    }

    audit('member.review', {
      actor_external_id: session.sub,
      target: started.memberName,
      result: action,
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    // ---------------------------------------------------------------- 同步开通
    const cfg = getConfig();
    const outcome = await provisionApplication({
      app: started,
      client: getOrganizationClient(),
      policyType: cfg.memberAccount.policyType,
      permissionIds: cfg.memberAccount.permissionIds,
    });

    const finished = await mutateStore((list) => {
      const app = findById(list, id);
      if (!app) throw new ApiError(404, '申请单不存在', 'not_found');

      // 回写令牌：开通期间申请单可能已被改走
      // - 本人超时自救把状态改回 pending 并可能改了部门；
      // - 另一次重试接管了本轮开通（provisioningStartedAt 被覆写）。
      // 任一情况都丢弃本次结果，避免用旧结果覆盖新状态（否则 pending 被吞、事件轨迹错乱）。
      if (
        app.status !== 'provisioning' ||
        app.provisioningStartedAt !== started.provisioningStartedAt
      ) {
        return null;
      }

      const at = new Date().toISOString();
      assertTransition('provisioning', outcome.status);
      Object.assign(app, {
        status: outcome.status,
        uin: outcome.uin ?? app.uin,
        resolvedNodeId: outcome.resolvedNodeId ?? app.resolvedNodeId,
        resolvedNodePath: outcome.resolvedNodePath ?? app.resolvedNodePath,
        errorCode: outcome.errorCode,
        errorMessage: outcome.errorMessage,
        // RequestId 只在失败时有排障价值：成功单保留上一次失败的值会被当成「仍有错误」
        tencentRequestId: outcome.status === 'active' ? null : outcome.requestId,
        provisioningStartedAt: null,
        lastAttemptAt: at,
        updatedAt: at,
      });
      const createdNote =
        outcome.createdDepartments.length > 0
          ? `，新建部门：${outcome.createdDepartments.join('/')}`
          : '';
      app.events.push({
        at,
        from: 'provisioning',
        to: outcome.status,
        actor: 'system',
        note:
          outcome.errorMessage ??
          (outcome.status === 'active' ? `开通完成${createdNote}` : createdNote.replace(/^，/, '')),
      });
      return app;
    });

    if (!finished) {
      // 本次开通结果已过期（申请单被改走）：返回真实状态，让页面按新状态渲染
      const current = await readStore();
      const app = findById(current, id);
      if (!app) throw new ApiError(404, '申请单不存在', 'not_found');
      console.warn('[members] 开通结果已过期，丢弃回写', { id, status: app.status });
      return jsonNoStore({ application: app, superseded: true });
    }

    return jsonNoStore({ application: finished });
  } catch (error) {
    return jsonError(error);
  }
}
