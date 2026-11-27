/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/// <reference types="vite/client" />

/**
 * Vite 浏览器侧类型（`import.meta.env`）。
 * 只用于 `ui/**` 的 SPA 适配器；Next 页面继续使用自己的环境类型。
 */

/** 构建期注入的 UI build ID（见 `lib/admin-build-id.ts`），与 `ui-version.json` 同值。 */
declare const __ADMIN_UI_BUILD_ID__: string | undefined;

/** 构建期注入的公网前缀（规范化、无尾斜杠；根部署为空串）。 */
declare const __ADMIN_UI_PUBLIC_BASE__: string | undefined;
