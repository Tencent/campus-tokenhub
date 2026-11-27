/**
 * Logo 上传。
 *
 * Logo 存在配置表的 `portal.logo` 里（data URL），不引入对象存储：
 * 一张 ≤200KB 的图没必要为它加一个 COS 桶和一套凭证。
 */

import { NextResponse } from 'next/server';
import {
  ApiError,
  assertMethod,
  assertSameOrigin,
  jsonError,
  requireSession,
} from '@/lib/api/guard';
import { audit, clientIp } from '@/lib/audit';
import { requireSettingsAdmin } from '@/lib/config/settings-access';
import { writeConfigEntries } from '@/lib/config/store';
import { invalidateConfigOverlay, refreshConfigOverlay } from '@/lib/config/overlay';
import { isDangerousSvg, LOGO_ALLOWED_TYPES, LOGO_MAX_BYTES, sniffLogoType, toLogoDataUrl } from '@/lib/config/logo';

export const dynamic = 'force-dynamic';

const ALLOWED_TYPES = new Set<string>(LOGO_ALLOWED_TYPES);

export async function POST(request: Request): Promise<NextResponse> {
  try {
    assertMethod(request, ['POST']);
    assertSameOrigin(request);
    const session = await requireSession(request);
    await requireSettingsAdmin(session);

    // 先看声明长度，避免为了判断 200KB 上限把超大 body 全量读进内存
    const declared = Number(request.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > LOGO_MAX_BYTES) {
      throw new ApiError(400, '图片不能超过 200KB，请压缩后重试', 'logo_too_large');
    }

    const buffer = Buffer.from(await request.arrayBuffer());
    if (buffer.byteLength === 0) {
      throw new ApiError(400, '图片内容为空，请重新选择文件', 'invalid_logo_type');
    }
    if (buffer.byteLength > LOGO_MAX_BYTES) {
      throw new ApiError(400, '图片不能超过 200KB，请压缩后重试', 'logo_too_large');
    }

    // 类型以魔数为准：请求头可以被改成 image/svg+xml 来夹带脚本
    const type = sniffLogoType(buffer);
    if (!type || !ALLOWED_TYPES.has(type)) {
      throw new ApiError(400, '仅支持 PNG、JPEG、SVG 格式的图片', 'invalid_logo_type');
    }
    if (type === 'image/svg+xml' && isDangerousSvg(buffer)) {
      throw new ApiError(400, 'SVG 中不能包含脚本或外链，请导出为静态图片', 'unsafe_logo');
    }

    const dataUrl = toLogoDataUrl(type, buffer);
    const actor = { sub: session.sub, ip: clientIp(request.headers) };

    await writeConfigEntries({ values: { logo: dataUrl }, ...actor });
    invalidateConfigOverlay();
    await refreshConfigOverlay();

    audit('config.change', {
      actor_external_id: session.sub,
      target: 'portal.logo',
      result: 'success',
      detail: `${type} ${buffer.byteLength}B`,
      ip: actor.ip,
    });

    return NextResponse.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
