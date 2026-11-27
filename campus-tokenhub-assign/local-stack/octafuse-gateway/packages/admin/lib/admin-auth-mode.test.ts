/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
	adminAuthModeState,
	resetAdminAuthModeWarnings,
	resolveAdminAuthMode,
} from './admin-auth-mode';

const LONG_SECRET = 'x'.repeat(32);

beforeEach(() => {
	resetAdminAuthModeWarnings();
});

describe('resolveAdminAuthMode', () => {
	it('默认 portal，且接受三种合法值', () => {
		assert.equal(resolveAdminAuthMode(undefined), 'portal');
		assert.equal(resolveAdminAuthMode(''), 'portal');
		assert.equal(resolveAdminAuthMode('password'), 'password');
		assert.equal(resolveAdminAuthMode('both'), 'both');
		assert.equal(resolveAdminAuthMode(' Portal '), 'portal');
	});

	it('非法值回退 portal', () => {
		assert.equal(resolveAdminAuthMode('sso'), 'portal');
	});
});

describe('adminAuthModeState', () => {
	it('portal + 足够长的密钥 → 启用门户会话', () => {
		const state = adminAuthModeState('portal', LONG_SECRET);
		assert.equal(state.portalRequested, true);
		assert.equal(state.portalEnabled, true);
		assert.equal(state.ssoNotConfigured, false);
	});

	it('portal + 缺密钥 → 标记未配置（不阻塞启动）', () => {
		const state = adminAuthModeState('portal', '');
		assert.equal(state.portalEnabled, false);
		assert.equal(state.ssoNotConfigured, true);
	});

	it('portal + 密钥过短 → 同样视为未配置', () => {
		const state = adminAuthModeState('portal', 'short');
		assert.equal(state.portalEnabled, false);
		assert.equal(state.ssoNotConfigured, true);
	});

	it('password 模式不要求密钥，也不报未配置', () => {
		const state = adminAuthModeState('password', '');
		assert.equal(state.portalRequested, false);
		assert.equal(state.portalEnabled, false);
		assert.equal(state.ssoNotConfigured, false);
	});

	it('both + 缺密钥 → 跳过门户分支但仍标记未配置（账密可用）', () => {
		const state = adminAuthModeState('both', '');
		assert.equal(state.portalRequested, true);
		assert.equal(state.portalEnabled, false);
		assert.equal(state.ssoNotConfigured, true);
	});
});
