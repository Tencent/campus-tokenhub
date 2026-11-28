/**
 * 页面访问上报（统一采买站）。
 *
 * 会话由 `requireSession` 兜（未登录 401），跨站提交由 `assertSameOrigin` 兜。
 * 请求体兼容两种 Content-Type：`sendBeacon` 直接传字符串时是 `text/plain`，
 * 只有包成 Blob 才是 `application/json`；两种都必须能解析，否则 PV 会静默全 0。
 *
 * 响应 204：beacon 不读响应体，返回内容没有意义。
 */

import { NextResponse } from 'next/server';
import { normalizeVisitPath } from '@campus/portal-activity';
import { ApiError, assertSameOrigin, jsonError, requireSession } from '@/lib/api/guard';
import { isActivityEnabled } from '@/lib/activity/enabled';
import { activityRecorder } from '@/lib/activity/recorder';

export const dynamic = 'force-dynamic';

/** 从 JSON 或纯文本请求体里取 path；解析不出来返回 null */
async function readPath(request: Request): Promise<string | null> {
  const contentType = (request.headers.get('content-type') ?? '').toLowerCase();

  if (contentType.includes('application/json')) {
    const body: unknown = await request.json().catch(() => null);
    const path = (body as { path?: unknown } | null)?.path;
    return typeof path === 'string' ? path : null;
  }

  const text = await request.text().catch(() => '');
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    const path = (parsed as { path?: unknown } | null)?.path;
    return typeof path === 'string' ? path : null;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertSameOrigin(request);
    const session = await requireSession(request);

    // 设置页开关关闭：静默丢弃，仍返回 204。埋点不能影响页面，也不应该写库。
    if (!(await isActivityEnabled())) {
      return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    }

    const raw = await readPath(request);
    if (!raw) throw new ApiError(400, '缺少页面路径', 'invalid_path');

    const path = normalizeVisitPath(raw);
    if (!path) throw new ApiError(400, '页面路径非法', 'invalid_path');

    // 埋点失败一律降级为 204：beacon 不读响应体，写库失败只影响统计，不能影响页面。
    // recorder 内部已 catch 并做告警节流，这里是最后一道兜底（防未来改动让它抛错）。
    try {
      await activityRecorder.recordPageView(session.sub, path);
    } catch {
      // 静默：任何写入异常都不向浏览器暴露
    }

    return new NextResponse(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
