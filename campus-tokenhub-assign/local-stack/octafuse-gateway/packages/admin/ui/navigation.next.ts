/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Next 构建下的导航实现（design D3）。
 *
 * 业务组件统一从 `@/ui/navigation` 导入：Vite 构建解析到 `ui/navigation.ts`
 * （React Router 适配器），Next 构建通过 `next.config.mjs` 的 alias 解析到本文件。
 */
export * from 'next/navigation';
