/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvRowsToString } from '../csv';
import {
	buildSummaryQuery,
	buildUserCsvRows,
	formatMetric,
	isRangeTooLong,
	siteLabel,
	USER_CSV_HEADER,
} from './view';

const RANGE = { start_date: '2026-11-21', end_date: '2026-11-27' };

describe('buildSummaryQuery', () => {
	it('带日期、站点与排序', () => {
		const query = buildSummaryQuery(RANGE, { site: 'assign', sort: 'logins' });
		const params = new URLSearchParams(query);
		assert.equal(params.get('start_date'), '2026-11-21');
		assert.equal(params.get('end_date'), '2026-11-27');
		assert.equal(params.get('site'), 'assign');
		assert.equal(params.get('sort'), 'logins');
	});

	it('空搜索词不带 q', () => {
		const params = new URLSearchParams(buildSummaryQuery(RANGE, { site: 'all', sort: 'page_views', q: '   ' }));
		assert.equal(params.has('q'), false);
	});

	it('搜索词带 q 并 trim', () => {
		const params = new URLSearchParams(
			buildSummaryQuery(RANGE, { site: 'all', sort: 'page_views', q: '  张伟  ' })
		);
		assert.equal(params.get('q'), '张伟');
	});

	it('导出时带 limit', () => {
		const params = new URLSearchParams(
			buildSummaryQuery(RANGE, { site: 'all', sort: 'page_views', limit: 5000 })
		);
		assert.equal(params.get('limit'), '5000');
	});

	it('看板 range 带时分秒时截到日期（接口只收 YYYY-MM-DD）', () => {
		const params = new URLSearchParams(
			buildSummaryQuery(
				{ start_date: '2026-11-21 00:00:00', end_date: '2026-11-27 14:08:58' },
				{ site: 'all', sort: 'page_views' }
			)
		);
		assert.equal(params.get('start_date'), '2026-11-21');
		assert.equal(params.get('end_date'), '2026-11-27');
	});
});

describe('isRangeTooLong', () => {
	it('90 天内放行', () => {
		assert.equal(isRangeTooLong('2026-01-01', '2026-03-31'), false);
	});

	it('超过 90 天拦下', () => {
		assert.equal(isRangeTooLong('2026-01-01', '2026-04-01'), true);
	});

	it('倒序或非法日期不误判', () => {
		assert.equal(isRangeTooLong('2026-11-27', '2026-11-21'), false);
		assert.equal(isRangeTooLong('', ''), false);
	});

	it('带时分秒的区间同样按日期比较跨度', () => {
		assert.equal(isRangeTooLong('2026-01-01 00:00:00', '2026-04-01 23:59:59'), true);
	});
});

describe('buildUserCsvRows', () => {
	it('表头固定', () => {
		assert.deepEqual(buildUserCsvRows([])[0], [...USER_CSV_HEADER]);
	});

	it('空数据只有表头', () => {
		assert.equal(buildUserCsvRows([]).length, 1);
	});

	it('姓名邮箱为空时留空，站点转中文', () => {
		const rows = buildUserCsvRows([
			{
				name: null,
				email: null,
				site: 'member',
				logins: 3,
				pageViews: 12,
				activeDays: 2,
				lastActiveAt: '2026-11-27T01:00:00.000Z',
			},
		]);
		assert.deepEqual(rows[1], ['', '', '成员自购', '3', '12', '2', '2026-11-27T01:00:00.000Z']);
	});

	it('含逗号与引号的内容被正确转义', () => {
		const csv = csvRowsToString(
			buildUserCsvRows([
				{
					name: '张,伟"老师',
					email: 'a@school.edu',
					site: 'assign',
					logins: 1,
					pageViews: 1,
					activeDays: 1,
					lastActiveAt: null,
				},
			])
		);
		assert.ok(csv.includes('"张,伟""老师"'));
	});

	it('含换行的内容整格加引号，不破坏行结构', () => {
		const csv = csvRowsToString(
			buildUserCsvRows([
				{
					name: '张\n伟',
					email: 'b@school.edu',
					site: 'member',
					logins: 2,
					pageViews: 3,
					activeDays: 1,
					lastActiveAt: null,
				},
			])
		);
		assert.ok(csv.includes('"张\n伟"'));
	});

	it('换行出现在邮箱时同样被引号包裹（\r\n 一并覆盖）', () => {
		const csv = csvRowsToString(
			buildUserCsvRows([
				{
					name: '李四',
					email: 'c@school.edu\r\nx',
					site: 'assign',
					logins: 1,
					pageViews: 1,
					activeDays: 1,
					lastActiveAt: null,
				},
			])
		);
		assert.ok(csv.includes('"c@school.edu\r\nx"'));
	});
});

describe('siteLabel / formatMetric', () => {
	it('站点文案', () => {
		assert.equal(siteLabel('assign'), '统一采买');
		assert.equal(siteLabel('member'), '成员自购');
		assert.equal(siteLabel('unknown'), 'unknown');
	});

	it('整数补千分位，小数保留一位', () => {
		assert.equal(formatMetric(1284), '1,284');
		assert.equal(formatMetric(26.34), '26.3');
		assert.equal(formatMetric(Number.NaN), '0');
	});
});
