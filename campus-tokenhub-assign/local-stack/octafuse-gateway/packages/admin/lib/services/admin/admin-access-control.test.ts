/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { GatewayDatabaseClient } from '@octafuse/core';
import {
	hasAdminPermission,
	normalizeAdminPermissions,
	parseAdminPermissions,
	type AdminPrincipal,
} from '../../admin-principal';
import { getAdminAuthorizationDecision } from '../../admin-permissions';
import { prepareAdminConfigRows } from '../../admin-config-secrets';
import { authenticateAdminRequest, generateAdminApiKey, hashSessionToken, timingSafeEqualSecret } from '../../auth';

const routeWriter: AdminPrincipal = {
	type: 'api_key',
	id: 'admin_key:routes-bot',
	keyId: 'routes-bot',
	permissions: ['routes.write'],
};

test('write permission includes matching read but no unrelated permission', () => {
	assert.equal(hasAdminPermission(routeWriter, 'routes.read'), true);
	assert.equal(hasAdminPermission(routeWriter, 'routes.write'), true);
	assert.equal(hasAdminPermission(routeWriter, 'analytics.read'), false);
});

test('star normalizes to the only stored permission and grants delegable permissions', () => {
	assert.deepEqual(normalizeAdminPermissions(['routes.read', '*', 'logs.read']), ['*']);
	const principal: AdminPrincipal = {
		type: 'api_key', id: 'admin_key:full', keyId: 'full', permissions: ['*'],
	};
	assert.equal(hasAdminPermission(principal, 'providers.secrets.read'), true);
	assert.deepEqual(parseAdminPermissions('["*","unknown.permission"]'), ['*']);
});

test('mcp write does not reveal upstream secrets', () => {
	const writer: AdminPrincipal = {
		type: 'api_key',
		id: 'admin_key:mcp',
		keyId: 'mcp',
		permissions: ['mcp.write'],
	};
	assert.equal(hasAdminPermission(writer, 'mcp.read'), true);
	assert.equal(hasAdminPermission(writer, 'mcp.secrets.read'), false);
});

test('permission matrix protects console-only surfaces and defaults to deny', () => {
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/access-keys'), { kind: 'console_only' });
	// Access Audit 已移除：该路径必须落入兜底 deny，不得被重新注册为可访问面
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/admin-audit-logs'), { kind: 'deny' });
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/providers/p1/api-key'), {
		kind: 'permission', permission: 'providers.secrets.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/providers/p1/quota'), {
		kind: 'permission', permission: 'providers.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/playground/realtime'), {
		kind: 'permission', permission: 'playground.execute',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/users/u1/display-discounts'), {
		kind: 'permission', permission: 'users.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/users/u1/audit-logs'), {
		kind: 'permission', permission: 'logs.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/keys/k1/logs'), {
		kind: 'permission', permission: 'logs.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/analytics/keys'), {
		kind: 'permission', permission: 'analytics.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/oauth-access-tokens'), {
		kind: 'permission', permission: 'user_keys.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('POST', '/admin/oauth-access-tokens/t1/revoke'), {
		kind: 'permission', permission: 'user_keys.write',
	});
	assert.deepEqual(getAdminAuthorizationDecision('POST', '/admin/users/u1/oauth-access-tokens'), {
		kind: 'permission', permission: 'user_keys.write',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/users/u1/oauth-access-tokens'), {
		kind: 'permission', permission: 'user_keys.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/not-registered'), { kind: 'deny' });
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/mcp-servers'), { kind: 'permission', permission: 'mcp.read' });
	assert.deepEqual(getAdminAuthorizationDecision('POST', '/admin/mcp-servers/server-1/sync'), { kind: 'permission', permission: 'mcp.write' });
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/mcp-servers/server-1/reveal'), {
		kind: 'permission', permission: 'mcp.secrets.read',
	});
});

test('maintenance has its own read/write permission pair', () => {
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/maintenance'), {
		kind: 'permission', permission: 'maintenance.read',
	});
	assert.deepEqual(getAdminAuthorizationDecision('PUT', '/admin/maintenance'), {
		kind: 'permission', permission: 'maintenance.write',
	});
	const configWriter: AdminPrincipal = {
		type: 'api_key', id: 'admin_key:cfg', keyId: 'cfg', permissions: ['config.write'],
	};
	assert.equal(hasAdminPermission(configWriter, 'maintenance.write'), false);
	const operator: AdminPrincipal = {
		type: 'api_key', id: 'admin_key:ops', keyId: 'ops', permissions: ['maintenance.write'],
	};
	assert.equal(hasAdminPermission(operator, 'maintenance.read'), true);
	assert.equal(hasAdminPermission(operator, 'config.write'), false);
});

test('oauth consent is separate from oauth management', () => {
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/oauth/authorization-requests/abc'), {
		kind: 'permission', permission: 'oauth.consent',
	});
	assert.deepEqual(getAdminAuthorizationDecision('POST', '/admin/oauth/authorization-requests/abc/accept'), {
		kind: 'permission', permission: 'oauth.consent',
	});
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/oauth/apps'), { kind: 'permission', permission: 'oauth.read' });
	assert.deepEqual(getAdminAuthorizationDecision('POST', '/admin/oauth/apps/x/revoke'), {
		kind: 'permission', permission: 'oauth.write',
	});
	// 旧的访问令牌接口仍归 user_keys
	assert.deepEqual(getAdminAuthorizationDecision('GET', '/admin/oauth-access-tokens'), {
		kind: 'permission', permission: 'user_keys.read',
	});
	const portal: AdminPrincipal = {
		type: 'api_key', id: 'admin_key:portal', keyId: 'portal', permissions: ['oauth.consent', 'user_keys.write'],
	};
	assert.equal(hasAdminPermission(portal, 'oauth.consent'), true);
	assert.equal(hasAdminPermission(portal, 'oauth.read'), false);
	assert.equal(hasAdminPermission(portal, 'oauth.write'), false);
});

test('config masking removes legacy MASTER_KEY and recursively masks catalog credentials', () => {
	const rows = prepareAdminConfigRows([
		{ key: 'MASTER_KEY', value: 'legacy', description: null },
		{ key: 'ALERT_WEBHOOK_WECOM_URL', value: 'https://example.test/hook/secret', description: null },
		{ key: 'WEB_SEARCH_CATALOG', value: JSON.stringify({ tavily: { apiKey: 'tvly-secret', metered: 1 } }), description: null },
	], false);
	assert.equal(rows.some((row) => row.key === 'MASTER_KEY'), false);
	assert.equal(rows[0]?.value, '••••••••');
	assert.equal(JSON.parse(rows[1]?.value ?? '{}').tavily.apiKey, '••••••••');
});

test('admin secrets and session hashes use expected formats', async () => {
	const key = generateAdminApiKey();
	assert.match(key, /^sk-admin-[0-9a-f]{64}$/);
	assert.match(await hashSessionToken('session-token'), /^[0-9a-f]{64}$/);
	assert.notEqual(await hashSessionToken('session-token'), await hashSessionToken('other-token'));
	assert.equal(await timingSafeEqualSecret('admin-password', 'admin-password'), true);
	assert.equal(await timingSafeEqualSecret('admin-password', 'wrong-password'), false);
});

test('authentication resolves active named keys and persistent sessions', async () => {
	const sessionToken = 'valid-session';
	const expectedSessionHash = await hashSessionToken(sessionToken);
	let touchedKeyId: string | null = null;
	const repositories = {
		adminAccess: {
			getActiveApiKeyBySecret: async (secret: string) => secret === 'active-secret' ? {
				id: 'routes-bot', name: 'routes-bot', description: null, secretKey: secret,
				keyPrefix: 'active-secret', permissionsJson: '["routes.write"]', status: 'active' as const,
				lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', revokedAt: null,
			} : null,
			touchApiKey: async (id: string) => { touchedKeyId = id; },
			getValidSession: async (tokenHash: string) => tokenHash === expectedSessionHash ? {
				tokenHash, username: 'admin', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2027-01-01T00:00:00.000Z',
			} : null,
		},
		systemConfig: { getConfig: async () => null },
	};

	assert.deepEqual(
		await authenticateAdminRequest(new Request('https://admin.test/api/admin/routes', {
			headers: { authorization: 'Bearer active-secret' },
		}), repositories),
		{ type: 'api_key', id: 'admin_key:routes-bot', keyId: 'routes-bot', permissions: ['routes.write'] }
	);
	assert.equal(touchedKeyId, 'routes-bot');
	assert.deepEqual(
		await authenticateAdminRequest(new Request('https://admin.test/api/admin/routes', {
			headers: { cookie: `admin_session=${sessionToken}` },
		}), repositories),
		{ type: 'console', id: 'console:admin', username: 'admin' }
	);
	assert.equal(await authenticateAdminRequest(new Request('https://admin.test/api/admin/routes', {
		headers: { authorization: 'Bearer revoked-or-unknown' },
	}), repositories), null);
});

// ---------------------------------------------------------------- 门户会话（SSO）

const PORTAL_SECRET = 'portal-session-secret-at-least-32-chars-long';

function portalToken(overrides: Record<string, unknown> = {}): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(JSON.stringify({
		purpose: 'portal-session',
		sub: 'teacher-1',
		email: 'Teacher@School.edu',
		name: '李老师',
		octafuse_user_id: 'gw-1',
		admin: true,
		iat: now,
		exp: now + 3600,
		...overrides,
	})).toString('base64url');
	const signature = createHmac('sha256', PORTAL_SECRET).update(`${header}.${payload}`).digest('base64url');
	return `${header}.${payload}.${signature}`;
}

function withAuthEnv(mode: string | undefined, secret: string | undefined, run: () => Promise<void>) {
	const previousMode = process.env.ADMIN_AUTH_MODE;
	const previousSecret = process.env.PORTAL_SESSION_SECRET;
	if (mode === undefined) delete process.env.ADMIN_AUTH_MODE; else process.env.ADMIN_AUTH_MODE = mode;
	if (secret === undefined) delete process.env.PORTAL_SESSION_SECRET; else process.env.PORTAL_SESSION_SECRET = secret;
	return run().finally(() => {
		if (previousMode === undefined) delete process.env.ADMIN_AUTH_MODE; else process.env.ADMIN_AUTH_MODE = previousMode;
		if (previousSecret === undefined) delete process.env.PORTAL_SESSION_SECRET; else process.env.PORTAL_SESSION_SECRET = previousSecret;
	});
}

/** 任何 DB 会话都查不到：用来证明门户分支不依赖 admin_session。 */
const emptyRepositories = {
	adminAccess: {
		getActiveApiKeyBySecret: async () => null,
		touchApiKey: async () => undefined,
		getValidSession: async () => null,
	},
	// 门户会话要按当前名单复核（读不到即拒绝）：测试里用下面的 rosterClient 提供名单
	systemConfig: { getConfig: async () => null },
};

/** 名单是唯一权威来源：读得到且命中才放行 */
const rosterClient = {
	driver: 'postgres',
	raw: async () => [{ sub: 'teacher-1' }],
} as unknown as GatewayDatabaseClient;

test('portal 模式下管理员门户会话映射为 console principal', async () => {
	await withAuthEnv('portal', PORTAL_SECRET, async () => {
		assert.deepEqual(
			await authenticateAdminRequest(new Request('https://admin.test/api/admin/users', {
				headers: { cookie: `portal_session=${portalToken()}` },
			}), emptyRepositories, rosterClient),
			{ type: 'console', id: 'console:teacher@school.edu', username: 'teacher@school.edu' },
		);
	});
});

test('门户会话没有 admin 声明时拒绝', async () => {
	await withAuthEnv('portal', PORTAL_SECRET, async () => {
		assert.equal(await authenticateAdminRequest(new Request('https://admin.test/api/admin/users', {
			headers: { cookie: `portal_session=${portalToken({ admin: false })}` },
		}), emptyRepositories), null);
	});
});

test('password 模式忽略门户会话（回滚开关生效）', async () => {
	await withAuthEnv('password', PORTAL_SECRET, async () => {
		assert.equal(await authenticateAdminRequest(new Request('https://admin.test/api/admin/users', {
			headers: { cookie: `portal_session=${portalToken()}` },
		}), emptyRepositories), null);
	});
});

test('过期 admin_session 不短路，仍可凭门户会话放行（回归）', async () => {
	const staleHash = await hashSessionToken('stale-session');
	await withAuthEnv('portal', PORTAL_SECRET, async () => {
		const repositories = {
			adminAccess: {
				getActiveApiKeyBySecret: async () => null,
				touchApiKey: async () => undefined,
				// 只有 stale 会话能查到，且判定为「已过期」→ 返回 null
				getValidSession: async (tokenHash: string) => tokenHash === staleHash ? null : null,
			},
			systemConfig: { getConfig: async () => null },
		};
		const principal = await authenticateAdminRequest(new Request('https://admin.test/api/admin/users', {
			headers: { cookie: `admin_session=stale-session; portal_session=${portalToken()}` },
		}), repositories, rosterClient);
		assert.deepEqual(principal, {
			type: 'console', id: 'console:teacher@school.edu', username: 'teacher@school.edu',
		});
	});
});

test('缺 PORTAL_SESSION_SECRET 时不抛错、按未认证处理', async () => {
	await withAuthEnv('portal', undefined, async () => {
		assert.equal(await authenticateAdminRequest(new Request('https://admin.test/api/admin/users', {
			headers: { cookie: `portal_session=${portalToken()}` },
		}), emptyRepositories), null);
	});
});
