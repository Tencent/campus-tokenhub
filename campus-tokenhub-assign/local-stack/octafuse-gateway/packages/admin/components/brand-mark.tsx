/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import Image from 'next/image';
import { adminBrowserPaths } from '@/lib/admin-browser-path';

/** Shared, decorative brand symbol; adjacent translated text names the product. */
export default function BrandMark({ className = 'h-10 w-10' }: { className?: string }) {
  return (
    <Image
      // 静态资源同样要走公网前缀：前缀部署下裸 `/brand/...` 会落到域名根被 nginx 404。
      src={adminBrowserPaths.asset('/brand/octafuse-symbol.svg')}
      alt=""
      aria-hidden="true"
      width={64}
      height={64}
      className={`shrink-0 ${className}`}
      loading="eager"
      draggable={false}
      unoptimized
    />
  );
}
