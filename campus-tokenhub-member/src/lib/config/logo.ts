/**
 * Logo 的存储格式与校验。
 *
 * 放在 lib 里而不是 route 文件里：Next 的 route 文件只允许导出 HTTP 方法与少量配置，
 * 多导出一个常量都会让整条路由类型校验失败（构建期才发现）。
 */

/** 单张 Logo 上限：200KB（base64 后约 273K 字符，注册表上限 280K） */
export const LOGO_MAX_BYTES = 200 * 1024;

/** 允许的类型：SVG 单独处理（回传时加 CSP sandbox，见 branding/logo 路由） */
export const LOGO_ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml'] as const;

export type LogoType = (typeof LOGO_ALLOWED_TYPES)[number];

const ALLOWED = new Set<string>(LOGO_ALLOWED_TYPES);

export type ParsedLogo = { type: string; bytes: Buffer };

/** 只接受 data URL，且 MIME 必须在白名单内 */
export function parseLogoDataUrl(dataUrl: string): ParsedLogo | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl.trim());
  if (!match) return null;

  const type = match[1].toLowerCase();
  if (!ALLOWED.has(type)) return null;

  try {
    return { type, bytes: Buffer.from(match[2], 'base64') };
  } catch {
    return null;
  }
}

export function toLogoDataUrl(type: string, bytes: Buffer): string {
  return `data:${type};base64,${bytes.toString('base64')}`;
}

/**
 * 按魔数识别真实类型。
 *
 * 只信请求头会被「任意二进制 + 声明的 content-type」绕过（声明成 SVG 再塞脚本），
 * 因此类型一律以文件内容为准。
 */
export function sniffLogoType(bytes: Buffer): LogoType | null {
  if (bytes.length < 4) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  // SVG: 文本，允许 BOM / 前导空白 / XML 声明，首个元素必须是 <svg
  const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (head.startsWith('<svg') || head.startsWith('<?xml')) {
    return 'image/svg+xml';
  }

  return null;
}

/**
 * 数字实体（`&#106;` / `&#x6a;`）解码：`href="&#106;avascript:..."` 在属性值里
 * 看起来不是 `javascript:`，但浏览器解析标签时会先解码，因此必须解码后再判。
 * 只解数字实体（不碰命名实体，避免把 `&amp;` 之类改写后误判）。
 */
function decodeNumericEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);?/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    });
}

/** href / xlink:href 里的脚本协议（解码后判断，允许空白与大小写变形） */
const DANGEROUS_HREF = /(?:href|xlink:href)\s*=\s*["']?[^"'>]*?(?:javascript|vbscript|data)\s*:/i;

/**
 * SVG 里出现可执行内容时直接拒绝。
 *
 * 只做「明显危险」的拦截（脚本、事件属性、foreignObject、外链脚本协议），
 * 真正的兜底是回传时的 CSP sandbox。上传与设置页写入两条路径共用本函数。
 */
export function isDangerousSvg(bytes: Buffer): boolean {
  const raw = bytes.toString('utf8');
  const text = decodeNumericEntities(raw);
  return (
    /<script[\s>]/i.test(text) ||
    // `[\s/]` 覆盖 `<svg/onload=`：`/` 不是空白，旧正则漏了自闭合写法
    /[\s/]on[a-z]+\s*=/i.test(text) ||
    /<foreignObject[\s>]/i.test(text) ||
    DANGEROUS_HREF.test(text)
  );
}
