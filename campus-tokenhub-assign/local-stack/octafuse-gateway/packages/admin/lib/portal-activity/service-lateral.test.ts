/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import { queryPortalActivitySummary, type PortalActivityQuery } from './service';

/**
 * G4：排行里的姓名/邮箱不能只在「本窗口内有登录事件」时才拿得到。
 *
 * 真实失败场景：用户 30 天内只浏览未登录（或在窗口前登录过），排行姓名显示空白。
 * 这里锁住 SQL 契约——身份查找取该 sub 全表最近一条登录事件，不带时间窗口条件。
 */

type Captured = { query: string; params?: unknown[] };

function fakeRepos(captured: Captured[], timezone: string | null = null): GatewayRepositories {
	return {
		client: {
			driver: 'postgres',
			raw: {
				unsafe: async (query: string, params?: unknown[]) => {
					captured.push({ query, params });
					return [];
				},
			},
		},
		systemConfig: { getConfig: async () => timezone },
	} as unknown as GatewayRepositories;
}

const BASE_QUERY: PortalActivityQuery = {
	start: '2026-11-01',
	end: '2026-11-27',
	days: 27,
	site: 'all',
	sort: 'page_views',
	q: '',
	limit: 100,
};

async function run(
	query: Partial<PortalActivityQuery> = {},
	timezone: string | null = null
): Promise<Captured[]> {
	const captured: Captured[] = [];
	await queryPortalActivitySummary(fakeRepos(captured, timezone), { ...BASE_QUERY, ...query });
	return captured;
}

function rankingEntry(captured: Captured[]): Captured {
	// KPI 与排行都以 `WITH l AS` 开头，用 ident 块精确定位排行查询
	const found = captured.find((entry) => entry.query.includes('ident AS ('));
	assert.ok(found, '排行查询应当被执行');
	return found;
}

function usersQuery(captured: Captured[]): string {
	return rankingEntry(captured).query;
}

describe('排行身份关联（G4）', () => {
	it('姓名/邮箱取该用户全表最近一条登录事件', async () => {
		const sql = usersQuery(await run());

		assert.match(sql, /ORDER BY le\.occurred_at DESC LIMIT 1/);
		assert.ok(
			sql.includes('(SELECT le.name FROM portal_shared.login_events le'),
			'姓名应来自 login_events 的最近一条'
		);
	});

	it('身份子查询不带时间窗口条件，跨窗口用户也有姓名', async () => {
		const sql = usersQuery(await run());
		const identBlock = sql.slice(sql.indexOf('), ident AS ('), sql.indexOf('), latest AS ('));

		assert.ok(identBlock.length > 0, '应当能找到 ident 块');
		assert.ok(
			!identBlock.includes('occurred_at >='),
			'ident 子查询不允许带时间窗口，否则窗口外的用户姓名会丢'
		);
		assert.ok(
			!identBlock.includes('$1::timestamptz'),
			'ident 子查询不允许引用窗口起点参数'
		);
	});

	it('区间端点按业务时区换算成 UTC 时间点（差一天或符号写反都会被拦）', async () => {
		const captured = await run({}, 'Asia/Shanghai');
		const entry = rankingEntry(captured);

		// 2026-11-01 00:00 +08:00 = 2026-10-31T16:00Z；end 为包含式，右边界取次日 00:00
		assert.equal(entry.params?.[0], '2026-10-31T16:00:00.000Z');
		assert.equal(entry.params?.[1], '2026-11-27T16:00:00.000Z');
	});

	it('排序与搜索下推到 SQL，limit 走参数绑定', async () => {
		const captured = await run({ sort: 'logins', q: 'zhang', limit: 250 }, 'Asia/Shanghai');
		const entry = rankingEntry(captured);
		const sql = entry.query;

		assert.ok(sql.includes('position(lower($4) in lower('), '搜索应在 SQL 侧匹配姓名/邮箱');
		assert.ok(
			sql.includes('COALESCE(ident.name') && sql.includes('COALESCE(ident.email'),
			'搜索应同时覆盖姓名与邮箱'
		);
		assert.ok(sql.includes('ORDER BY'), '排序应在 SQL 侧执行');
		assert.ok(sql.includes('LIMIT $5'), 'limit 应走参数绑定而不是拼字符串');
		assert.equal(entry.params?.length, 6);
		assert.equal(entry.params?.[3], 'zhang');
		assert.equal(entry.params?.[4], 250);
		assert.equal(entry.params?.[5], 'all');
		assert.match(
			String(entry.params?.[2]),
			/^[A-Za-z][A-Za-z_+-]*(\/[A-Za-z_+-]+)?$/,
			'时区应以 IANA 名传入（默认 UTC，配置后为 Area/City）'
		);
	});
});
