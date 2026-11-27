/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Next 构建下的 Link 实现（design D3）。
 *
 * 业务组件统一从 `@/ui/link` 导入：Vite 构建解析到 `ui/link.tsx`（React Router），
 * Next 构建通过 `next.config.mjs` 的 alias 解析到本文件，保持 Next 原生行为。
 */
export { default } from 'next/link';
export * from 'next/link';
