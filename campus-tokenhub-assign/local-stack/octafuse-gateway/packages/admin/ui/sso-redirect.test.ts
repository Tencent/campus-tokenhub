/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import { describe, expect, it } from 'vitest';
import { buildSsoLoginTarget, currentAdminNextPath } from './sso-redirect';

describe('currentAdminNextPath', () => {
	it('剥掉公网前缀，只留管理台自身路径', () => {
		expect(
			currentAdminNextPath(
				{ pathname: '/tokenhub/admin/gateway/users/1', search: '?tab=keys', hash: '#section' },
				'/tokenhub/admin',
			),
		).toBe('/gateway/users/1?tab=keys#section');
	});

	it('根部署（空前缀）原样保留', () => {
		expect(currentAdminNextPath({ pathname: '/dashboard', search: '', hash: '' }, '')).toBe(
			'/dashboard',
		);
	});

	it('恰好落在前缀根时回到 /', () => {
		expect(currentAdminNextPath({ pathname: '/tokenhub/admin', search: '', hash: '' }, '/tokenhub/admin')).toBe(
			'/',
		);
	});

	it('相似前缀不被误剥（/tokenhub/administrator）', () => {
		expect(
			currentAdminNextPath({ pathname: '/tokenhub/administrator', search: '', hash: '' }, '/tokenhub/admin'),
		).toBe('/tokenhub/administrator');
	});

	it('路径不以斜杠开头时补斜杠', () => {
		expect(currentAdminNextPath({ pathname: 'gateway/users', search: '', hash: '' }, '')).toBe(
			'/gateway/users',
		);
	});
});

describe('buildSsoLoginTarget', () => {
	it.each([
		['/gateway/users/1?tab=keys', '/gateway/users/1?tab=keys'],
		['/gateway/users/1#section', '/gateway/users/1#section'],
		['/模型/用量', '/模型/用量'],
		['/gateway/users/1?q=a b', '/gateway/users/1?q=a b'],
	])('next 完整编码并可被还原：%s', (path, expected) => {
		const url = new URL(buildSsoLoginTarget('https://api.test/tokenhub/portal/login', path));

		expect(url.origin + url.pathname).toBe('https://api.test/tokenhub/portal/login');
		expect(url.searchParams.get('dest')).toBe('admin');
		expect(url.searchParams.get('next')).toBe(expected);
	});

	it('原始 url 里的既有 query 不被吞掉', () => {
		const url = new URL(buildSsoLoginTarget('https://api.test/login?from=admin', '/dashboard'));

		expect(url.searchParams.get('from')).toBe('admin');
		expect(url.searchParams.get('next')).toBe('/dashboard');
	});
});
