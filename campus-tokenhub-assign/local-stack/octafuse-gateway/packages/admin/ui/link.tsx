/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 首组过渡用的 Next `Link` 兼容适配器（design D3）。
 *
 * 1.2 只迁移 dashboard 与 users/:id，其余 21 个页面仍由 Next 保留路径服务。
 * 为避免复制业务页面，本文件在 Vite/Vitest 中替换 `next/link`：
 * - 目标命中 `admin-ui-route-manifest` 时走 React Router 软导航；
 * - 未迁移页面回退为普通 `<a>`，由浏览器整页请求交给 Node/Next 保留路径。
 *
 * 2.2 全量迁移后，页面应改为直接导入 `@/ui/navigation` 的 Link，
 * 本适配器只保留给尚未迁移的共享组件使用。
 */
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { joinAdminPublicPath } from '@/lib/admin-public-path';
import { matchAdminUiRoute } from '@/lib/admin-ui-route-manifest';
import { ADMIN_UI_PUBLIC_BASE } from './public-path';

type NextLinkHref =
	| string
	| {
			pathname?: string;
			query?: Record<string, string | number | boolean | undefined>;
			hash?: string;
	  };

export interface AdminUiLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
	href: NextLinkHref;
	replace?: boolean;
	children?: ReactNode;
}

function hrefToString(href: NextLinkHref): string {
	if (typeof href === 'string') return href;
	const pathname = href.pathname ?? '/';
	const search = new URLSearchParams();
	for (const [key, value] of Object.entries(href.query ?? {})) {
		if (value === undefined) continue;
		search.set(key, String(value));
	}
	const query = search.toString();
	return `${pathname}${query ? `?${query}` : ''}${href.hash ?? ''}`;
}

export default function Link({
	href,
	replace,
	children,
	...anchorProps
}: AdminUiLinkProps) {
	const target = hrefToString(href);
	const pathname = target.split('#')[0]?.split('?')[0] || '/';

	if (!matchAdminUiRoute(pathname)) {
		// 非清单内部路径（例如未来新增、尚未迁移的页面）走整页请求：
		// 必须带上公网前缀，否则前缀部署会落到域名根 404。
		return (
			<a href={joinAdminPublicPath(ADMIN_UI_PUBLIC_BASE, target)} {...anchorProps}>
				{children}
			</a>
		);
	}

	return (
		<RouterLink to={target} replace={replace} {...anchorProps}>
			{children}
		</RouterLink>
	);
}
