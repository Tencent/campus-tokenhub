import { NextResponse } from 'next/server';
import { ApiError, assertMethod, jsonError, jsonNoStore, requireSession } from '@/lib/api/guard';
import { resolvePortalAdmin } from '@/lib/auth/admin';
import { readAdminCandidates } from '@/lib/admin/candidates';

export const dynamic = 'force-dynamic';

/**
 * 管理员名单的可选身份（姓名 + `school_id:user_id`）。
 *
 * 返回的是**全校用户**的个人信息，必须与写名单同一口径鉴权：
 * 漏掉管理员校验就等于把通讯录开放给所有登录用户。
 * 因此响应额外加 `no-store`，避免被中间层缓存后跨用户读取。
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['GET']);
    const session = await requireSession(request);
    if (!(await resolvePortalAdmin(session))) {
      throw new ApiError(403, '管理员名单仅对全局管理员开放', 'not_portal_admin');
    }

    const raw = new URL(request.url).searchParams.get('q') ?? '';
    const candidates = await readAdminCandidates({
      currentSub: session.sub,
      query: raw.trim().slice(0, 60),
    });

    return jsonNoStore({ candidates });
  } catch (error) {
    return jsonError(error);
  }
}
