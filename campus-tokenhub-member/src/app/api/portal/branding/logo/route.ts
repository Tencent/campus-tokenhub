/**
 * Logo 读取。
 *
 * 从运行期配置（`portal.logo` 的 data URL）解出二进制直接返回，
 * 浏览器侧用 `<img src="/api/portal/branding/logo">`，不需要把 base64 塞进 HTML。
 */

import { NextResponse } from 'next/server';
import { getConfig } from '@/lib/config';
import { parseLogoDataUrl } from '@/lib/config/logo';

export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  const logo = getConfig().portal.logo;
  const parsed = logo ? parseLogoDataUrl(logo) : null;

  if (!parsed || parsed.bytes.byteLength === 0) {
    return NextResponse.json({ error: '尚未配置 Logo', code: 'logo_absent' }, { status: 404 });
  }

  const isSvg = parsed.type === 'image/svg+xml';

  return new NextResponse(new Uint8Array(parsed.bytes), {
    status: 200,
    headers: {
      'content-type': parsed.type,
      'content-length': String(parsed.bytes.byteLength),
      // 声明类型必须被遵守，不允许浏览器嗅探成别的类型
      'x-content-type-options': 'nosniff',
      // 该路径在 middleware 里是公开的：SVG 被直接打开时用 CSP sandbox 禁掉脚本，
      // 并让浏览器按附件下载，避免变成同源存储型 XSS
      ...(isSvg
        ? {
            'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
            'content-disposition': 'attachment; filename="logo.svg"',
          }
        : {}),
      // Logo 变更频率极低，允许浏览器缓存 5 分钟；保存后由页面刷新自然更新
      'cache-control': 'public, max-age=300',
    },
  });
}
