/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理台 → 门户登录页的跳转地址拼装。
 *
 * 两个容易出错的点（评审 I2）：
 * 1. 当前地址要**剥掉公网前缀**（`/tokenhub/admin`），`next` 只带管理台自己的相对路径；
 * 2. `next` 必须完整编码——直接字符串拼接会让 `?tab=keys` 变成门户登录页自身的参数、
 *    让 `#section` 永远到不了服务端，深链接静默丢失。
 *
 * 纯函数，不依赖 React / window。
 */
export interface AdminLocation {
	pathname: string;
	search: string;
	hash: string;
}

export function currentAdminNextPath(location: AdminLocation, publicBase: string): string {
	const rawPath = location.pathname || '/';
	const prefix = (publicBase || '').replace(/\/+$/, '');
	let path = rawPath;

	if (prefix && (rawPath === prefix || rawPath.startsWith(`${prefix}/`))) {
		path = rawPath.slice(prefix.length) || '/';
	}
	if (!path.startsWith('/')) path = `/${path}`;
	if (path.startsWith('//')) path = '/';

	return `${path}${location.search ?? ''}${location.hash ?? ''}`;
}

export function buildSsoLoginTarget(loginUrl: string, currentPath: string): string {
	const target = new URL(loginUrl);
	target.searchParams.set('dest', 'admin');
	// searchParams.set 会做 encodeURIComponent，避免 `?`/`#`/中文/空格被截断
	target.searchParams.set('next', currentPath);
	return target.toString();
}
