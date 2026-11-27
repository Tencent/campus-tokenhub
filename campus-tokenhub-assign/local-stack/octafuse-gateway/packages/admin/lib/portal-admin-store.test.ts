/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户管理员名单（`portal.member_admins`）读取契约。
 *
 * 关键区分：`ok` + 空数组 = 「表在、没人」；`unavailable` = 「读不到」。
 * 后者必须让调用方退回白名单/owner，否则共库前提不成立时会把人全挡在门外。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayDatabaseClient } from '@octafuse/core';
import { readPortalMemberAdminSubs } from './portal-admin-store';

function postgresClient(handler: () => Promise<unknown>): GatewayDatabaseClient {
	return { driver: 'postgres', raw: handler } as unknown as GatewayDatabaseClient;
}

describe('readPortalMemberAdminSubs', () => {
	it('读出名单并去掉空白项', async () => {
		const result = await readPortalMemberAdminSubs(
			postgresClient(async () => [{ sub: '100051:1012173' }, { sub: '  ' }, { sub: '100051:2' }]),
		);

		assert.deepEqual(result, { status: 'ok', subs: ['100051:1012173', '100051:2'] });
	});

	it('表存在但没人时返回 ok + 空数组（不是 unavailable）', async () => {
		const result = await readPortalMemberAdminSubs(postgresClient(async () => []));

		assert.deepEqual(result, { status: 'ok', subs: [] });
	});

	it('查询失败（表不存在 / 无权限）返回 unavailable:query', async () => {
		const result = await readPortalMemberAdminSubs(
			postgresClient(async () => {
				throw new Error('relation "portal.member_admins" does not exist');
			}),
		);

		assert.deepEqual(result, { status: 'unavailable', reason: 'query' });
	});

	it('没给连接时返回 unavailable:no_client', async () => {
		assert.deepEqual(await readPortalMemberAdminSubs(undefined), {
			status: 'unavailable',
			reason: 'no_client',
		});
	});

	it('非 Postgres 驱动不尝试查询', async () => {
		let called = false;
		const client = {
			driver: 'mysql',
			raw: async () => {
				called = true;
				return [];
			},
		} as unknown as GatewayDatabaseClient;

		assert.deepEqual(await readPortalMemberAdminSubs(client), {
			status: 'unavailable',
			reason: 'driver',
		});
		assert.equal(called, false);
	});
});
