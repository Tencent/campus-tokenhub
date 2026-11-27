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
import { resolvePortalAdmin } from '@/lib/auth/admin';
import {
  LastAdminError,
  addAdmins,
  isValidAdminSub,
  readAdminSubs,
  removeAdmin,
} from '@/lib/admin/roster';
import type { SessionPayload } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/** 一次最多添加多少人：弹窗是多选，给个上限避免误点全选写崩 */
const MAX_BATCH = 50;

async function requireAdminManager(session: SessionPayload): Promise<void> {
  if (!(await resolvePortalAdmin(session))) {
    throw new ApiError(403, '管理员名单仅对全局管理员开放', 'not_portal_admin');
  }
}

/**
 * 待添加的身份：`subs` 数组（弹窗多选）为主，`sub` 单值保留兼容。
 * 去重后逐个校验，任一非法整批拒绝——不写一半。
 */
function readSubs(body: Record<string, unknown>): string[] {
  const raw = body.subs;
  const list = Array.isArray(raw)
    ? raw.map((item) => String(item ?? '').trim())
    : [String(body.sub ?? '').trim()];
  const entries = [...new Set(list.filter(Boolean))];

  if (entries.length === 0) {
    throw new ApiError(400, '请选择要添加的管理员', 'invalid_sub');
  }
  if (entries.length > MAX_BATCH) {
    throw new ApiError(400, `一次最多添加 ${MAX_BATCH} 位管理员`, 'too_many_subs');
  }
  for (const entry of entries) {
    if (!isValidAdminSub(entry)) {
      throw new ApiError(400, '身份格式应为 school_id:user_id', 'invalid_sub');
    }
  }
  return entries;
}

/**
 * 管理员名单维护：改共享层 `portal_shared.admins`（一行一个身份）。
 *
 * 自删一律拒绝：名单是唯一放行依据，自己把自己踢掉就再也进不来这个页面了。
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireAdminManager(session);

    const entries = readSubs(await readBody(request));
    const subs = await addAdmins(entries);

    for (const entry of entries) {
      audit('portal.admin', {
        actor_external_id: session.sub,
        target: entry,
        result: 'added',
        ip: clientIp(request.headers),
        ua: request.headers.get('user-agent'),
      });
    }

    return jsonNoStore({ subs });
  } catch (error) {
    return jsonError(error);
  }
}

export async function DELETE(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['DELETE']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireAdminManager(session);

    const body = await readBody(request);
    const sub = String(body.sub ?? '').trim();
    if (!isValidAdminSub(sub)) {
      throw new ApiError(400, '身份格式应为 school_id:user_id', 'invalid_sub');
    }
    if (sub === session.sub) {
      throw new ApiError(400, '不能移除自己，请让另一位管理员操作', 'cannot_remove_self');
    }

    const { subs: currentSubs } = await readAdminSubs();
    if (!currentSubs.includes(sub)) {
      throw new ApiError(404, '该身份不在管理员名单里', 'admin_not_found');
    }

    const subs = await removeAdmin(sub).catch((error: unknown) => {
      if (error instanceof LastAdminError) {
        throw new ApiError(400, '至少保留一名管理员，不能移除最后一位', 'last_admin');
      }
      throw error;
    });

    audit('portal.admin', {
      actor_external_id: session.sub,
      target: sub,
      result: 'removed',
      ip: clientIp(request.headers),
      ua: request.headers.get('user-agent'),
    });

    return jsonNoStore({ subs });
  } catch (error) {
    return jsonError(error);
  }
}
