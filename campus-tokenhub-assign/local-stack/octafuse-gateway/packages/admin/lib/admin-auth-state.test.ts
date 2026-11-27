/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `/api/auth/check` 判定契约：**永远是 200 语义**、永远带 `authenticated` 与 `mode`。
 *
 * 这里只测纯函数（路由层只剩 cookies() 与 json 包装）。健康检查写死
 * `if (a.status !== 200) return bad(...)`，本文件是「不要把 503 当降级手段」的护栏。
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { GatewayDatabaseClient } from '@octafuse/core';
import { resetAdminAuthModeWarnings } from './admin-auth-mode';
import { resolveAdminAuthState } from './admin-auth-state';
import { hashSessionToken } from './auth';

const PORTAL_SECRET = 'portal-session-secret-at-least-32-chars-long';
const LOGIN_URL = 'https://api.example.com/tokenhub/portal/login';

function portalToken(overrides: Record<string, unknown> = {}): string {
	const now = Math.floor(Date.now() / 1000);
	const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
	const payload = Buffer.from(
		JSON.stringify({
			purpose: 'portal-session',
			sub: 'teacher-1',
			email: 'teacher@school.edu',
			name: '李老师',
			octafuse_user_id: 'gw-1',
			admin: true,
			iat: now,
			exp: now + 3600,
			...overrides,
		}),
	).toString('base64url');
	const signature = createHmac('sha256', PORTAL_SECRET).update(`${header}.${payload}`).digest('base64url');
	return `${header}.${payload}.${signature}`;
}

const noSession = {
	adminAccess: {
		getActiveApiKeyBySecret: async () => null,
		touchApiKey: async () => undefined,
		getValidSession: async () => null,
	},
	// 门户会话的 admin 声明要按「当前口径」复核：名单是唯一来源（读不到即拒绝），
	// 所以这里给一个能读到名单的连接，名单里放本测试身份
	systemConfig: {
		getConfig: async () => null,
	},
};

const rosterClient = {
	driver: 'postgres',
	raw: async () => [{ sub: 'teacher-1' }],
} as unknown as GatewayDatabaseClient;

function stateFor(overrides: Partial<Parameters<typeof resolveAdminAuthState>[0]> = {}) {
	return resolveAdminAuthState({
		adminSessionToken: null,
		portalSessionToken: null,
		repositories: noSession,
		client: rosterClient,
		loginUrl: LOGIN_URL,
		...overrides,
	});
}

const previousEnv = {
	mode: process.env.ADMIN_AUTH_MODE,
	secret: process.env.PORTAL_SESSION_SECRET,
	adminEmails: process.env.PORTAL_ADMIN_EMAILS,
};

beforeEach(() => {
	resetAdminAuthModeWarnings();
	process.env.ADMIN_AUTH_MODE = 'portal';
	process.env.PORTAL_SESSION_SECRET = PORTAL_SECRET;
	delete process.env.PORTAL_ADMIN_EMAILS;
});

afterEach(() => {
	if (previousEnv.mode === undefined) delete process.env.ADMIN_AUTH_MODE;
	else process.env.ADMIN_AUTH_MODE = previousEnv.mode;
	if (previousEnv.secret === undefined) delete process.env.PORTAL_SESSION_SECRET;
	else process.env.PORTAL_SESSION_SECRET = previousEnv.secret;
	if (previousEnv.adminEmails === undefined) delete process.env.PORTAL_ADMIN_EMAILS;
	else process.env.PORTAL_ADMIN_EMAILS = previousEnv.adminEmails;
	resetAdminAuthModeWarnings();
});

describe('resolveAdminAuthState', () => {
	it('管理员门户会话 → authenticated + via:portal + mode', async () => {
		const state = await stateFor({ portalSessionToken: portalToken() });

		assert.deepEqual(state, {
			authenticated: true,
			mode: 'portal',
			loginUrl: LOGIN_URL,
			username: 'teacher@school.edu',
			via: 'portal',
		});
	});

	it('有效 DB 会话优先，via:session', async () => {
		const tokenHash = await hashSessionToken('db-session');
		const state = await stateFor({
			adminSessionToken: 'db-session',
			repositories: {
				adminAccess: {
					getActiveApiKeyBySecret: async () => null,
					touchApiKey: async () => undefined,
					getValidSession: async (hash: string) =>
						hash === tokenHash
							? {
									tokenHash,
									username: 'admin',
									createdAt: '2026-01-01T00:00:00.000Z',
									expiresAt: '2027-01-01T00:00:00.000Z',
								}
							: null,
				},
				systemConfig: { getConfig: async () => null },
			},
		});

		assert.equal(state.authenticated, true);
		assert.equal(state.via, 'session');
		assert.equal(state.username, 'admin');
	});

	it('过期 DB 会话 + 合法门户会话 → 仍放行（回归）', async () => {
		const state = await stateFor({
			adminSessionToken: 'stale',
			portalSessionToken: portalToken(),
		});

		assert.equal(state.authenticated, true);
		assert.equal(state.via, 'portal');
	});

	it('门户会话有效但非管理员 → reason:not_admin（前端不得自动跳转）', async () => {
		const state = await stateFor({ portalSessionToken: portalToken({ admin: false }) });

		assert.equal(state.authenticated, false);
		assert.equal(state.reason, 'not_admin');
		assert.equal(state.mode, 'portal');
	});

	it('缺密钥 → reason:sso_not_configured，且仍带 authenticated/mode', async () => {
		delete process.env.PORTAL_SESSION_SECRET;
		resetAdminAuthModeWarnings();

		const state = await stateFor({ portalSessionToken: portalToken() });

		assert.equal(state.authenticated, false);
		assert.equal(state.reason, 'sso_not_configured');
		assert.equal(state.mode, 'portal');
	});

	it('未登录 → authenticated:false + loginUrl + mode', async () => {
		const state = await stateFor();

		assert.equal(state.authenticated, false);
		assert.equal(state.mode, 'portal');
		assert.equal(state.loginUrl, LOGIN_URL);
		assert.equal(state.reason, undefined);
	});

	it('password 模式即使带门户会话也返回未认证', async () => {
		process.env.ADMIN_AUTH_MODE = 'password';
		resetAdminAuthModeWarnings();

		const state = await stateFor({ portalSessionToken: portalToken() });

		assert.equal(state.authenticated, false);
		assert.equal(state.mode, 'password');
	});

	it('撤权后旧门户会话不再放行：已不在名单里', async () => {
		const state = await stateFor({
			portalSessionToken: portalToken(),
			repositories: {
				adminAccess: { ...noSession.adminAccess },
				systemConfig: { getConfig: async () => null },
			},
			client: {
				driver: 'postgres',
				raw: async () => [{ sub: 'someone-else' }],
			} as unknown as GatewayDatabaseClient,
		});

		assert.equal(state.authenticated, false);
		assert.equal(state.reason, 'not_admin');
	});

	it('邮箱白名单已移除：设置 PORTAL_ADMIN_EMAILS 不影响判定', async () => {
		// 白名单曾能放行「不在名单表里的人」，但 IdP 不返回邮箱时整条失效、邮箱又可被改写，
		// 已从 portal-admin-guard 移除；现在唯一权威来源是门户管理员名单 / 初始化 owner。
		// 这个用例锁住「不要再把邮箱重新接回判定」。
		process.env.PORTAL_ADMIN_EMAILS = 'other@school.edu';
		const state = await stateFor({ portalSessionToken: portalToken() });

		assert.equal(state.authenticated, true);
		assert.equal(state.via, 'portal');
	});

	it('名单为空时拒绝（fail-closed，不再回落 owner）', async () => {
		const state = await stateFor({
			portalSessionToken: portalToken(),
			repositories: {
				adminAccess: { ...noSession.adminAccess },
				systemConfig: { getConfig: async () => null },
			},
			client: {
				driver: 'postgres',
				raw: async () => [],
			} as unknown as GatewayDatabaseClient,
		});

		assert.equal(state.authenticated, false);
		assert.equal(state.reason, 'not_admin');
	});
});
