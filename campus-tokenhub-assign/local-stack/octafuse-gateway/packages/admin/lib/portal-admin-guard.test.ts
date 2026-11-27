/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-26.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `isPortalAdminStillAllowed` 的判定契约。
 *
 * 目的只有一个：**门户管理员页加进来的人，管理台必须认**，并且撤权后立即不认。
 * 判定口径与门户 `resolvePortalAdmin` 严格一致：名单是唯一权威来源，
 * 读不到名单才降级到网关里的初始化 owner；邮箱白名单已彻底移除。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayDatabaseClient } from '@octafuse/core';
import { isPortalAdminStillAllowed } from './portal-admin-guard';

const OWNER = '100051:1012173';
const LISTED = '100051:2000001';

function postgresClient(rows: { sub: string }[] | Error): GatewayDatabaseClient {
	return {
		driver: 'postgres',
		raw: async () => {
			if (rows instanceof Error) throw rows;
			return rows;
		},
	} as unknown as GatewayDatabaseClient;
}

function repositories(owner: string | null = OWNER) {
	return { systemConfig: { getConfig: async () => owner } };
}

describe('isPortalAdminStillAllowed', () => {
	it('名单里的人放行（owner 不匹配也必须放行）', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: LISTED, email: '' },
			repositories('someone-else'),
			postgresClient([{ sub: OWNER }, { sub: LISTED }]),
		);

		assert.equal(allowed, true);
	});

	it('名单非空但没命中 → 拒绝，即使这个 sub 是初始化 owner', async () => {
		const asOwner = await isPortalAdminStillAllowed(
			{ sub: OWNER, email: '' },
			repositories(OWNER),
			postgresClient([{ sub: LISTED }]),
		);
		assert.equal(asOwner, false);

		const outsider = await isPortalAdminStillAllowed(
			{ sub: '100051:3000003', email: '' },
			repositories(OWNER),
			postgresClient([{ sub: LISTED }]),
		);
		assert.equal(outsider, false);
	});

	it('邮箱不再参与判定：不在名单里就拒绝，哪怕邮箱曾在白名单里', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: '100051:3000003', email: 'boss@school.edu' },
			repositories(OWNER),
			postgresClient([{ sub: LISTED }]),
		);

		assert.equal(allowed, false);
	});

	it('名单为空 → 拒绝（不再回落 owner，避免两套口径）', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: OWNER, email: '' },
			repositories(OWNER),
			postgresClient([]),
		);

		assert.equal(allowed, false);
	});

	it('读不到名单表时降级到 owner（共库前提不成立不比改动前更差）', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: OWNER, email: '' },
			repositories(OWNER),
			postgresClient(new Error('relation "portal_shared.admins" does not exist')),
		);

		assert.equal(allowed, true);
	});

	it('没有连接时降级到 owner', async () => {
		assert.equal(
			await isPortalAdminStillAllowed({ sub: OWNER, email: '' }, repositories(OWNER)),
			true,
		);
		assert.equal(
			await isPortalAdminStillAllowed({ sub: LISTED, email: '' }, repositories(OWNER)),
			false,
		);
	});

	it('owner 未认领且名单为空时拒绝（fail-closed）', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: OWNER, email: '' },
			repositories(null),
			postgresClient([]),
		);

		assert.equal(allowed, false);
	});

	it('名单里有空串脏数据时不会误放行空 sub', async () => {
		const allowed = await isPortalAdminStillAllowed(
			{ sub: '   ', email: '' },
			repositories(null),
			postgresClient([{ sub: '' }]),
		);

		assert.equal(allowed, false);
	});
});
