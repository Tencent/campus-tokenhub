/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 页面模块清单（design D3/D5）。
 *
 * 页面 `import()` 的唯一清单：
 * - `ui/routes.tsx` 据此创建 lazy 组件；
 * - `ui/prefetch.ts` 的 prefetcher 只调用这里的 loader，不额外包装请求；
 * - Node 端只消费 `lib/admin-ui-route-manifest.ts`，绝不导入本文件。
 *
 * 这里的 loader 只拉取路由 chunk，不发送业务 API、写操作、推理计费或 secret 请求。
 */
import type { AdminRouteLoader } from './prefetch';

export const ADMIN_UI_ROUTE_MODULES: Record<string, AdminRouteLoader> = {
	dashboard: () => import('@/app/dashboard/page'),
	providers: () => import('@/app/gateway/providers/page'),
	models: () => import('@/app/gateway/models/page'),
	routes: () => import('@/app/gateway/routes/page'),
	playground: () => import('@/app/gateway/playground/page'),
	simulator: () => import('@/app/gateway/simulator/page'),
	users: () => import('@/app/gateway/users/page'),
	'user-detail': () => import('@/app/gateway/users/[id]/page'),
	keys: () => import('@/app/gateway/keys/page'),
	'request-logs': () => import('@/app/gateway/request-logs/page'),
	'audit-logs': () => import('@/app/gateway/audit-logs/page'),
	tools: () => import('@/app/gateway/tools/page'),
	mcp: () => import('@/app/gateway/mcp/page'),
	'tool-invocations': () => import('@/app/gateway/tools/invocations/page'),
	'analytics-models': () => import('@/app/gateway/analytics/models/page'),
	'analytics-providers': () => import('@/app/gateway/analytics/providers/page'),
	'analytics-users': () => import('@/app/gateway/analytics/users/page'),
	'analytics-reliability': () => import('@/app/gateway/analytics/reliability/page'),
	'admin-api-keys': () => import('@/app/gateway/admin-api-keys/page'),
	config: () => import('@/app/gateway/config/page'),
};
