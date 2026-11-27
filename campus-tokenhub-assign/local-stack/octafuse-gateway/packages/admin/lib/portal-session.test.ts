/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户会话验签边界（管理台 SSO 的唯一身份来源）。
 *
 * 约束（design D1 / spec「管理台只接受白名单管理员的门户会话」）：
 * - 只接受 HS256 + `purpose=portal-session` 且 `admin=true` 的 token；
 * - 签名/过期/结构非法一律返回原因码，不抛异常、不"尽量放行"；
 * - 未配置密钥时返回 `not_configured`，由调用方降级（不阻塞进程启动）。
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { verifyPortalSession } from './portal-session';

const SECRET = 'portal-session-secret-at-least-32-chars';

function base64url(input: string | Buffer): string {
	return Buffer.from(input).toString('base64url');
}

function signToken(
	payload: Record<string, unknown>,
	options: { secret?: string; alg?: string } = {},
): string {
	const header = base64url(JSON.stringify({ alg: options.alg ?? 'HS256', typ: 'JWT' }));
	const body = base64url(JSON.stringify(payload));
	const signature = createHmac('sha256', options.secret ?? SECRET)
		.update(`${header}.${body}`)
		.digest('base64url');
	return `${header}.${body}.${signature}`;
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		purpose: 'portal-session',
		sub: 'teacher-1',
		email: 'teacher@school.edu',
		name: '李老师',
		octafuse_user_id: 'gw-1',
		admin: true,
		iat: now,
		exp: now + 3600,
		...overrides,
	};
}

describe('verifyPortalSession', () => {
	it('接受合法的管理员门户会话', async () => {
		const result = await verifyPortalSession(signToken(payload()), { secret: SECRET });

		assert.equal(result.ok, true);
		if (result.ok) {
			assert.deepEqual(result.principal, {
				sub: 'teacher-1',
				email: 'teacher@school.edu',
				name: '李老师',
			});
		}
	});

	it('拒绝用其他密钥签发的 token', async () => {
		const token = signToken(payload(), { secret: 'another-secret-another-secret-1234' });
		const result = await verifyPortalSession(token, { secret: SECRET });

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'bad_signature');
	});

	it('拒绝 purpose 不是门户会话的 token', async () => {
		const result = await verifyPortalSession(signToken(payload({ purpose: 'other' })), {
			secret: SECRET,
		});

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'wrong_purpose');
	});

	it('拒绝过期 token', async () => {
		const now = Math.floor(Date.now() / 1000);
		const result = await verifyPortalSession(signToken(payload({ exp: now - 10 })), {
			secret: SECRET,
		});

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'expired');
	});

	it('拒绝缺少 admin 声明的普通学生会话', async () => {
		const { admin: _admin, ...rest } = payload();
		const result = await verifyPortalSession(signToken(rest), { secret: SECRET });

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'not_admin');
	});

	it('拒绝 admin 非布尔真值的会话', async () => {
		const result = await verifyPortalSession(signToken(payload({ admin: 'true' })), {
			secret: SECRET,
		});

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'not_admin');
	});

	it('拒绝非 HS256 头（防算法替换）', async () => {
		const result = await verifyPortalSession(signToken(payload(), { alg: 'none' }), {
			secret: SECRET,
		});

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'malformed');
	});

	for (const token of ['', 'abc', 'a.b', 'a.b.c.d']) {
		it(`拒绝结构非法的 token: ${JSON.stringify(token)}`, async () => {
			const result = await verifyPortalSession(token, { secret: SECRET });

			assert.equal(result.ok, false);
			if (!result.ok) assert.equal(result.reason, 'malformed');
		});
	}

	it('未配置密钥时返回 not_configured 而不是抛错', async () => {
		const result = await verifyPortalSession(signToken(payload()), { secret: '' });

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'not_configured');
	});

	it('缺少 sub 的 token 视为结构非法', async () => {
		const { sub: _sub, ...rest } = payload();
		const result = await verifyPortalSession(signToken(rest), { secret: SECRET });

		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.reason, 'malformed');
	});
});
