/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	assertParamArity,
	assembleSummary,
	KPI_SQL,
	MAX_LIMIT,
	normalizeRange,
	parseDay,
	parseLimit,
	parseSite,
	parseSort,
	siteFilter,
	TREND_SQL,
	USERS_SQL,
} from './service';

describe('parseDay', () => {
	it('接受合法日期', () => {
		assert.equal(parseDay('2026-11-27'), '2026-11-27');
	});

	it('拒绝格式非法', () => {
		assert.equal(parseDay('2026/11/27'), null);
		assert.equal(parseDay('2026-11-27T00:00'), null);
		assert.equal(parseDay(''), null);
	});

	it('拒绝不存在的日期', () => {
		assert.equal(parseDay('2026-02-31'), null);
	});
});

describe('normalizeRange', () => {
	it('返回包含首尾的天数', () => {
		assert.deepEqual(normalizeRange('2026-11-21', '2026-11-27'), {
			start: '2026-11-21',
			end: '2026-11-27',
			days: 7,
		});
	});

	it('单日区间算 1 天', () => {
		assert.equal(normalizeRange('2026-11-27', '2026-11-27')?.days, 1);
	});

	it('倒序区间返回 null', () => {
		assert.equal(normalizeRange('2026-11-27', '2026-11-21'), null);
	});

	it('超过 90 天返回 null', () => {
		assert.equal(normalizeRange('2026-01-01', '2026-04-01'), null);
		assert.ok(normalizeRange('2026-01-01', '2026-03-31'));
	});

	it('日期非法返回 null', () => {
		assert.equal(normalizeRange('', '2026-11-27'), null);
	});
});

describe('parseSite / parseSort / parseLimit', () => {
	it('缺省值', () => {
		assert.equal(parseSite(undefined), 'all');
		assert.equal(parseSort(undefined), 'page_views');
		assert.equal(parseLimit(undefined), 100);
	});

	it('非法值返回 null', () => {
		assert.equal(parseSite('campus'), null);
		assert.equal(parseSort('tokens'), null);
		assert.equal(parseLimit('0'), null);
		assert.equal(parseLimit('-1'), null);
		assert.equal(parseLimit('abc'), null);
	});

	it('limit 上限被截断', () => {
		assert.equal(parseLimit('999999'), MAX_LIMIT);
	});
});

describe('assembleSummary', () => {
	const range = { start: '2026-11-21', end: '2026-11-27', site: 'all' as const };

	it('空数据返回零值而不是 NaN', () => {
		const summary = assembleSummary(range, undefined, [], []);
		assert.deepEqual(summary.kpi, {
			logins: 0,
			loginUsers: 0,
			pageViews: 0,
			activeUsers: 0,
			pvPerUser: 0,
		});
		assert.deepEqual(summary.users, []);
	});

	it('人均访问在分母为 0 时返回 0', () => {
		const summary = assembleSummary(
			range,
			{ logins: '0', login_users: '0', page_views: '10', active_users: '0' },
			[],
			[]
		);
		assert.equal(summary.kpi.pvPerUser, 0);
	});

	it('人均访问保留一位小数', () => {
		const summary = assembleSummary(
			range,
			{ logins: '5', login_users: '3', page_views: '100', active_users: '3' },
			[],
			[]
		);
		assert.equal(summary.kpi.pvPerUser, 33.3);
	});

	it('字符串数值被转成 number，时间转 ISO', () => {
		const summary = assembleSummary(
			range,
			{ logins: '12', login_users: '4', page_views: '80', active_users: '5' },
			[{ day: '2026-11-21', logins: '2', page_views: '10' }],
			[
				{
					sub: 'u-1',
					name: '张伟',
					email: 'z@school.edu',
					site: 'assign',
					logins: '3',
					page_views: '40',
					active_days: '5',
					last_active_at: '2026-11-27T01:02:03.000Z',
				},
			]
		);

		assert.equal(summary.trend[0]?.logins, 2);
		assert.equal(summary.users[0]?.pageViews, 40);
		assert.equal(summary.users[0]?.activeDays, 5);
		assert.equal(summary.users[0]?.lastActiveAt, '2026-11-27T01:02:03.000Z');
	});

	it('last_active_at 为 null 时保持 null', () => {
		const summary = assembleSummary(range, undefined, [], [
			{
				sub: 'u-1',
				name: null,
				email: null,
				site: 'member',
				logins: '0',
				page_views: '1',
				active_days: '1',
				last_active_at: null,
			},
		]);
		assert.equal(summary.users[0]?.lastActiveAt, null);
	});
});

describe('assertParamArity', () => {
	it('占位符与参数个数一致时放行', () => {
		assert.doesNotThrow(() => assertParamArity('SELECT $1, $2', [1, 2], 'demo'));
	});

	it('多传了 SQL 未引用的参数会拦下', () => {
		// pg 对这种参数只报 `could not determine data type of parameter $3`，很难反查
		assert.throws(() => assertParamArity('SELECT $1, $2', [1, 2, 3], 'demo'), /不匹配/);
	});

	it('三个查询的站点参数索引各自对齐（KPI 第 3 位，trend/users 第 6 位）', () => {
		assert.doesNotThrow(() =>
			assertParamArity(KPI_SQL(siteFilter('site', 3)), ['s', 'e', 'all'], 'kpi')
		);
		assert.doesNotThrow(() =>
			assertParamArity(TREND_SQL(siteFilter('site', 6)), ['s', 'e', 'tz', 'i1', 'i2', 'all'], 'trend')
		);
		assert.doesNotThrow(() =>
			assertParamArity(USERS_SQL(siteFilter('site', 6), 'sub'), ['i1', 'i2', 'tz', '', 100, 'all'], 'users')
		);
	});

	it('站点索引写错时三个查询都会报错', () => {
		assert.throws(() => assertParamArity(KPI_SQL(siteFilter('site', 6)), ['s', 'e', 'all'], 'kpi'));
		assert.throws(() => assertParamArity(TREND_SQL(siteFilter('site', 3)), ['s', 'e', 'tz', 'i1', 'i2', 'all'], 'trend'));
	});
});
