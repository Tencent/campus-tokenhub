/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 浏览器侧公网前缀（design D4）。
 *
 * 唯一来源是构建期 `ADMIN_UI_PUBLIC_PATH`（Vite `define` 注入 → `lib/admin-browser-path.ts`）。
 * `App` 的 Router basename、资源版本核对与所有手写请求都走这里，避免各文件各自解析前缀。
 */
import { adminBrowserPaths } from '@/lib/admin-browser-path';

export const ADMIN_UI_PUBLIC_BASE = adminBrowserPaths.base;

export const ADMIN_UI_ROUTER_BASENAME = adminBrowserPaths.routerBasename;
