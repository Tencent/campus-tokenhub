/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	assessAdminPasswordStrength,
	isAdminPasswordLoginEnabled,
	resolveAdminPasswordLogin,
} from './admin-password-policy';

const STRONG = 'T3st-Admin-Pass-9f2c';

describe('isAdminPasswordLoginEnabled', () => {
	it('只认 on / true / 1', () => {
		for (const raw of ['on', 'ON', ' true ', '1']) {
			assert.equal(isAdminPasswordLoginEnabled(raw), true, String(raw));
		}
		for (const raw of [undefined, null, '', 'off', 'yes', 'enabled']) {
			assert.equal(isAdminPasswordLoginEnabled(raw), false, String(raw));
		}
	});
});

describe('assessAdminPasswordStrength', () => {
	it('识别公开示例口令', () => {
		for (const value of ['change-me', 'octafuse123', 'OCTAFUSE123', 'password', 'admin', 'replace-me']) {
			assert.equal(assessAdminPasswordStrength(value), 'example', value);
		}
	});

	it('识别过短口令', () => {
		assert.equal(assessAdminPasswordStrength('Short-Pass-9'), 'too_short');
		assert.equal(assessAdminPasswordStrength(''), 'too_short');
	});

	it('放行强口令', () => {
		assert.equal(assessAdminPasswordStrength(STRONG), 'ok');
	});
});

describe('resolveAdminPasswordLogin', () => {
	it('portal 模式未显式开启时关闭账密通道（默认安全）', () => {
		assert.deepEqual(
			resolveAdminPasswordLogin({ mode: 'portal', username: 'admin', password: STRONG }),
			{ allowed: false, reason: 'disabled_by_mode' }
		);
	});

	it('凭据齐全也不能绕过开关：门户改用集成密钥后不再有内部后门', () => {
		// 旧实现给门户留了 internal 标记（x-tokenhub-portal-token = SESSION_SECRET），
		// 持密钥即可在 portal 模式下登录。该分支已删除，判定只认显式开关。
		for (const passwordLogin of [undefined, null, '', 'off']) {
			assert.deepEqual(
				resolveAdminPasswordLogin({
					mode: 'portal',
					passwordLogin,
					username: 'admin',
					password: STRONG,
				}),
				{ allowed: false, reason: 'disabled_by_mode' },
				String(passwordLogin)
			);
		}
	});

	it('portal 模式显式开启后允许强口令', () => {
		assert.deepEqual(
			resolveAdminPasswordLogin({
				mode: 'portal',
				passwordLogin: 'on',
				username: 'admin',
				password: STRONG,
			}),
			{ allowed: true }
		);
	});

	it('portal 模式即使显式开启也拒绝弱口令', () => {
		assert.deepEqual(
			resolveAdminPasswordLogin({
				mode: 'portal',
				passwordLogin: 'on',
				username: 'admin',
				password: 'short-pass',
			}),
			{ allowed: false, reason: 'weak_password' }
		);
	});

	it('显式开启但应急账密留空时视为未配置', () => {
		assert.deepEqual(
			resolveAdminPasswordLogin({ mode: 'portal', passwordLogin: 'on' }),
			{ allowed: false, reason: 'unconfigured' }
		);
	});

	it('示例口令在任何模式下都拒绝', () => {
		for (const mode of ['portal', 'password', 'both'] as const) {
			assert.deepEqual(
				resolveAdminPasswordLogin({
					mode,
					passwordLogin: 'on',
					username: 'admin',
					password: 'octafuse123',
				}),
				{ allowed: false, reason: 'weak_password' },
				mode
			);
		}
	});

	it('password / both 模式是应急回滚路径，短口令仍放行', () => {
		for (const mode of ['password', 'both'] as const) {
			assert.deepEqual(
				resolveAdminPasswordLogin({ mode, username: 'admin', password: 'short-pass' }),
				{ allowed: true },
				mode
			);
		}
	});

	it('缺凭据时视为未配置', () => {
		assert.deepEqual(resolveAdminPasswordLogin({ mode: 'password' }), {
			allowed: false,
			reason: 'unconfigured',
		});
	});
});
