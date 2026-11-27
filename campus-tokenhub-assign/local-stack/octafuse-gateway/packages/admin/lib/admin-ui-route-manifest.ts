/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 UI 的唯一纯数据路由清单（design D3）。
 *
 * 同一份清单同时驱动：
 * - 浏览器 `ui/routes.tsx` 的 React Router 绑定；
 * - Node `lib/admin-ui-dispatch.ts` 的已知页面匹配。
 *
 * 本模块只允许包含路径/跳转数据与纯函数，**不得**导入 React、页面组件、
 * Next、数据库或任何 secret 模块，保证 Node 入口不会把浏览器运行时拉进来。
 *
 * 2.2 起本清单覆盖全部 23 个管理台入口：20 个内容页 + 根重定向 + 2 个旧地址重定向
 * （OAuth 访问令牌、维护模式），与侧边栏菜单（`lib/admin-nav.ts`）逐项对齐。
 */

export type AdminUiRouteKind = 'page' | 'redirect';

export interface AdminUiRouteDefinition {
	/** 稳定标识；`ui/routes.tsx` 以此绑定 lazy 组件，Node 不关心组件。 */
	id: string;
	/** React Router / 匹配器共用的 path pattern，动态段使用 `:name`。 */
	pattern: string;
	kind: AdminUiRouteKind;
	/** `kind: 'redirect'` 时的客户端 replace 目标。 */
	redirectTo?: string;
}

export const ADMIN_UI_ROUTES: readonly AdminUiRouteDefinition[] = [
	{ id: 'root', pattern: '/', kind: 'redirect', redirectTo: '/dashboard' },
	{ id: 'dashboard', pattern: '/dashboard', kind: 'page' },

	// 推理网关
	{ id: 'providers', pattern: '/gateway/providers', kind: 'page' },
	{ id: 'models', pattern: '/gateway/models', kind: 'page' },
	{ id: 'routes', pattern: '/gateway/routes', kind: 'page' },
	{ id: 'playground', pattern: '/gateway/playground', kind: 'page' },
	{ id: 'simulator', pattern: '/gateway/simulator', kind: 'page' },

	// 用户与日志
	{ id: 'users', pattern: '/gateway/users', kind: 'page' },
	{ id: 'user-detail', pattern: '/gateway/users/:id', kind: 'page' },
	{ id: 'keys', pattern: '/gateway/keys', kind: 'page' },
	{ id: 'request-logs', pattern: '/gateway/request-logs', kind: 'page' },
	{ id: 'audit-logs', pattern: '/gateway/audit-logs', kind: 'page' },

	// 工具与 MCP
	{ id: 'tools', pattern: '/gateway/tools', kind: 'page' },
	{ id: 'mcp', pattern: '/gateway/mcp', kind: 'page' },
	{ id: 'tool-invocations', pattern: '/gateway/tools/invocations', kind: 'page' },

	// 统计
	{ id: 'analytics-models', pattern: '/gateway/analytics/models', kind: 'page' },
	{ id: 'analytics-providers', pattern: '/gateway/analytics/providers', kind: 'page' },
	{ id: 'analytics-users', pattern: '/gateway/analytics/users', kind: 'page' },
	{ id: 'analytics-reliability', pattern: '/gateway/analytics/reliability', kind: 'page' },

	// 集成与系统
	{ id: 'admin-api-keys', pattern: '/gateway/admin-api-keys', kind: 'page' },
	{ id: 'config', pattern: '/gateway/config', kind: 'page' },

	// 旧地址：维护模式已并入配置页，保留书签兼容（与 `app/gateway/maintenance/page.tsx`、
	// `lib/admin-nav.ts` 的旧路径归一化同一目标）。
	{
		id: 'legacy-maintenance',
		pattern: '/gateway/maintenance',
		kind: 'redirect',
		redirectTo: '/gateway/config#config-panel-maintenance',
	},

	// 旧地址：OAuth 访问令牌已并入 MCP 页，保留书签兼容。
	{
		id: 'legacy-oauth-access-tokens',
		pattern: '/gateway/oauth-access-tokens',
		kind: 'redirect',
		redirectTo: '/gateway/mcp#oauth-access-tokens',
	},
];

export interface AdminUiRouteMatch {
	route: AdminUiRouteDefinition;
	params: Record<string, string>;
}

function splitPathname(pathname: string): string[] | null {
	if (!pathname.startsWith('/')) return null;
	const withoutQuery = pathname.split('?')[0]?.split('#')[0] ?? '';
	const trimmed = withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
	return trimmed === '/' ? [] : trimmed.slice(1).split('/');
}

function splitPattern(pattern: string): string[] {
	const trimmed = pattern.length > 1 ? pattern.replace(/\/+$/, '') : pattern;
	return trimmed === '/' ? [] : trimmed.slice(1).split('/');
}

function decodeSegment(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

/**
 * 匹配已知 UI 路径。
 *
 * - 根路径与静态路径均忽略末尾斜杠；
 * - 动态段只匹配单个非空 segment，`/gateway/users/u-1/extra` 不会落到详情；
 * - query/hash 不参与匹配，由浏览器 Router 自行保留。
 */
export function matchAdminUiRoute(pathname: string): AdminUiRouteMatch | null {
	const segments = splitPathname(pathname);
	if (!segments) return null;

	for (const route of ADMIN_UI_ROUTES) {
		const patternSegments = splitPattern(route.pattern);
		if (patternSegments.length !== segments.length) continue;

		const params: Record<string, string> = {};
		let matched = true;
		for (let index = 0; index < patternSegments.length; index += 1) {
			const patternSegment = patternSegments[index]!;
			const pathSegment = segments[index]!;
			if (patternSegment.startsWith(':')) {
				const decoded = decodeSegment(pathSegment);
				if (!decoded) {
					matched = false;
					break;
				}
				params[patternSegment.slice(1)] = decoded;
				continue;
			}
			if (patternSegment !== pathSegment) {
				matched = false;
				break;
			}
		}
		if (matched) return { route, params };
	}

	return null;
}

export function isAdminUiRoutePath(pathname: string): boolean {
	return matchAdminUiRoute(pathname) !== null;
}
