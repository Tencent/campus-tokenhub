/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADMIN_NAV_GROUPS, formatAdminDocumentTitle, matchAdminNavRoute } from './admin-nav';

describe('matchAdminNavRoute', () => {
	it('matches exact sidebar paths', () => {
		assert.equal(matchAdminNavRoute('/gateway/simulator')?.nameKey, 'simulator');
		assert.equal(matchAdminNavRoute('/dashboard')?.nameKey, 'dashboard');
	});

	it('hides the REST service and MCP server entries from the sidebar', () => {
		assert.equal(matchAdminNavRoute('/gateway/tools'), null);
		assert.equal(matchAdminNavRoute('/gateway/mcp'), null);
	});

	it('does not render an empty tools group', () => {
		assert.equal(
			ADMIN_NAV_GROUPS.some((group) => group.groupKey === 'tools'),
			false,
		);
	});

	it('keeps request and audit logs in their own group, after users', () => {
		const keys = ADMIN_NAV_GROUPS.map((group) => group.groupKey);
		assert.equal(keys.indexOf('logs'), keys.indexOf('user') + 1);
		assert.deepEqual(
			ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'logs')?.items.map((item) => item.nameKey),
			['requestLogs', 'auditLogs'],
		);
		assert.deepEqual(
			ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'user')?.items.map((item) => item.nameKey),
			['users', 'apiKeys'],
		);
	});

	it('groups integration keys with Config and nests maintenance under Config', () => {
		const system = ADMIN_NAV_GROUPS.find((group) => group.groupKey === 'system');
		assert.deepEqual(
			system?.items.map((item) => item.nameKey),
			['config', 'adminApiKeys'],
		);
		assert.equal(matchAdminNavRoute('/gateway/maintenance')?.nameKey, 'config');
		assert.equal(matchAdminNavRoute('/gateway/config')?.nameKey, 'config');
		assert.equal(matchAdminNavRoute('/gateway/config#config-panel-maintenance')?.nameKey, 'config');
		assert.equal(ADMIN_NAV_GROUPS.some((group) => group.items.some((item) => item.nameKey === 'maintenance')), false);
		assert.equal(matchAdminNavRoute('/gateway/admin-api-keys')?.nameKey, 'adminApiKeys');
	});

	it('treats user detail as Users', () => {
		assert.equal(matchAdminNavRoute('/gateway/users/abc-123')?.nameKey, 'users');
	});

	it('does not confuse analytics users with the Users page', () => {
		assert.equal(matchAdminNavRoute('/gateway/analytics/users')?.nameKey, 'userUsage');
	});

	it('returns null for unknown paths', () => {
		assert.equal(matchAdminNavRoute('/'), null);
		assert.equal(matchAdminNavRoute('/unknown'), null);
	});
});

describe('formatAdminDocumentTitle', () => {
	it('puts the page function before the product title', () => {
		assert.equal(
			formatAdminDocumentTitle('Simulator', 'Octafuse Gateway · Admin'),
			'Simulator · Octafuse Gateway · Admin',
		);
	});

	it('falls back to the product title when the page is unknown', () => {
		assert.equal(formatAdminDocumentTitle(null, 'Octafuse Gateway · Admin'), 'Octafuse Gateway · Admin');
		assert.equal(formatAdminDocumentTitle('  ', 'Octafuse Gateway · Admin'), 'Octafuse Gateway · Admin');
	});
});
