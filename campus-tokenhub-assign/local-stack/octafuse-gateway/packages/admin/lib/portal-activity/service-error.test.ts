/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { queryPortalActivitySummary, type PortalActivityQuery } from './service';

/**
 * G6：数据库不可用时必须让错误冒到路由层变成 500，
 * 不能静默返回一份「全是 0」的看板——那会让运维以为「没人用」。
 */

const BASE_QUERY: PortalActivityQuery = {
	start: '2026-11-01',
	end: '2026-11-27',
	days: 27,
	site: 'all',
	sort: 'page_views',
	q: '',
	limit: 100,
};

function reposWithDriver(
	driver: string,
	unsafe: (query: string, params?: unknown[]) => Promise<unknown[]>
): GatewayRepositories {
	return {
		client: { driver, raw: { unsafe } },
		systemConfig: { getConfig: async () => null },
	} as unknown as GatewayRepositories;
}

describe('聚合错误可区分（G6）', () => {
	it('查询抛错时原样向上抛，不返回零值看板', async () => {
		const repositories = reposWithDriver('postgres', async () => {
			throw new Error('connection terminated unexpectedly');
		});

		await assert.rejects(
			() => queryPortalActivitySummary(repositories, BASE_QUERY),
			/connection terminated unexpectedly/
		);
	});

	it('非 postgres 驱动给出可区分的配置错误', async () => {
		const repositories = reposWithDriver('sqlite', async () => []);

		await assert.rejects(
			() => queryPortalActivitySummary(repositories, BASE_QUERY),
			/仅支持 postgres/
		);
	});

	it('时区配置读取失败也向上抛，不吞成默认值', async () => {
		const repositories = {
			client: { driver: 'postgres', raw: { unsafe: async () => [] } },
			systemConfig: {
				getConfig: async () => {
					throw new Error('config store unavailable');
				},
			},
		} as unknown as GatewayRepositories;

		await assert.rejects(
			() => queryPortalActivitySummary(repositories, BASE_QUERY),
			/config store unavailable/
		);
	});
});
