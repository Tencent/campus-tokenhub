/**
 * Logo 的浏览器地址。
 *
 * 地址里带内容指纹：换 Logo 后 URL 跟着变，浏览器缓存里不会留着旧图；
 * 内容不变时 URL 稳定，300 秒的响应缓存继续生效。
 *
 * 只在服务端调用（`node:crypto`），客户端组件拿到的已经是拼好的字符串。
 */

import { createHash } from 'node:crypto';
import { appPath } from '@/lib/paths';

export function brandLogoUrl(logo: string | null | undefined): string {
  const value = typeof logo === 'string' ? logo.trim() : '';
  if (!value.startsWith('data:image/')) return '';
  const version = createHash('sha1').update(value).digest('hex').slice(0, 8);
  return appPath(`/api/portal/branding/logo?v=${version}`);
}
