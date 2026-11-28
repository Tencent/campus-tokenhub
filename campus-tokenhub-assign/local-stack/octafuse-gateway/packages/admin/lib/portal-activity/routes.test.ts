/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户活跃度接口的参数校验测试。
 *
 * 成功路径依赖真实 Postgres（由组件组验收的 curl 全链路覆盖），
 * 这里只锁「不碰数据库就能判定的边界」：未认证、日期、站点、排序、上限。
 */

import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { adminPortalActivityRoutes } from './routes';

/** 只回答开关查询的假数据层：默认开启，便于沿用既有边界用例 */
function switchOnlyRepositories(enabled: boolean): unknown {
	return {
		client: {
			driver: 'postgres',
			raw: {
				unsafe: async (query: string) =>
					query.includes('activity_enabled') ? [{ activity_enabled: enabled }] : [],
			},
		},
		systemConfig: { getConfig: async () => null },
	};
}

function createApp(withPrincipal = true, activityEnabled = true): Hono<AdminEnv> {
	const app = new Hono<AdminEnv>();
	if (withPrincipal) {
		app.use('*', async (c, next) => {
			c.set('principal', { type: 'console' } as never);
			c.set('repositories', switchOnlyRepositories(activityEnabled) as never);
			await next();
		});
	}
	app.route('/admin/portal-activity', adminPortalActivityRoutes);
	return app;
}

const VALID = 'start_date=2026-11-21&end_date=2026-11-27';

describe('GET /admin/portal-activity/summary 边界', () => {
	it('未认证返回 401', async () => {
		const response = await createApp(false).request(`/admin/portal-activity/summary?${VALID}`);
		assert.equal(response.status, 401);
	});

	it('缺日期返回 400', async () => {
		const response = await createApp().request('/admin/portal-activity/summary');
		assert.equal(response.status, 400);
	});

	it('日期格式非法返回 400', async () => {
		const response = await createApp().request(
			'/admin/portal-activity/summary?start_date=2026/11/21&end_date=2026-11-27'
		);
		assert.equal(response.status, 400);
	});

	it('跨度超过 90 天返回 400', async () => {
		const response = await createApp().request(
			'/admin/portal-activity/summary?start_date=2026-01-01&end_date=2026-06-01'
		);
		assert.equal(response.status, 400);
	});

	it('站点取值非法返回 400', async () => {
		const response = await createApp().request(
			`/admin/portal-activity/summary?${VALID}&site=campus`
		);
		assert.equal(response.status, 400);
	});

	it('排序字段非法返回 400', async () => {
		const response = await createApp().request(
			`/admin/portal-activity/summary?${VALID}&sort=tokens`
		);
		assert.equal(response.status, 400);
	});

	it('limit 非正整数返回 400', async () => {
		const response = await createApp().request(`/admin/portal-activity/summary?${VALID}&limit=0`);
		assert.equal(response.status, 400);
	});
});

/** 注入只读数据层的应用：用于成功路径与失败路径（G6） */
function createAppWithRepositories(
	unsafe: (query: string, params?: unknown[]) => Promise<unknown[]>
): Hono<AdminEnv> {
	const app = new Hono<AdminEnv>();
	app.use('*', async (c, next) => {
		c.set('principal', { type: 'console' } as never);
		c.set(
			'repositories',
			{
				client: {
					driver: 'postgres',
					raw: {
						unsafe: async (query: string, params?: unknown[]) =>
							query.includes('activity_enabled')
								? [{ activity_enabled: true }]
								: unsafe(query, params),
					},
				},
				systemConfig: { getConfig: async () => null },
			} as never
		);
		await next();
	});
	app.route('/admin/portal-activity', adminPortalActivityRoutes);
	return app;
}

describe('GET /admin/portal-activity/summary 数据层结果', () => {
	it('无数据时返回 200 与零值，而不是 404/NaN', async () => {
		const app = createAppWithRepositories(async () => []);
		const response = await app.request(`/admin/portal-activity/summary?${VALID}`);
		const body = (await response.json()) as {
			success: boolean;
			data: { kpi: { logins: number; pageViews: number; pvPerUser: number } };
		};

		assert.equal(response.status, 200);
		assert.equal(body.success, true);
		assert.equal(body.data.kpi.logins, 0);
		assert.equal(body.data.kpi.pageViews, 0);
		assert.equal(body.data.kpi.pvPerUser, 0);
	});

	it('数据层抛错返回 500，不伪装成空数据', async () => {
		const app = createAppWithRepositories(async () => {
			throw new Error('connection terminated unexpectedly');
		});
		const response = await app.request(`/admin/portal-activity/summary?${VALID}`);
		const body = (await response.json()) as { success: boolean };

		assert.equal(response.status, 500);
		assert.equal(body.success, false);
	});
});

describe('功能开关（后台菜单与接口跟随门户设置）', () => {
	it('开关关闭时 summary 返回 403 且带可识别 code', async () => {
		const app = createApp(true, false);
		const response = await app.request(`/admin/portal-activity/summary?${VALID}`);
		const body = (await response.json()) as { success: boolean; code?: string };

		assert.equal(response.status, 403);
		assert.equal(body.success, false);
		assert.equal(body.code, 'feature_disabled');
	});

	it('开关关闭时参数错误也先被 403 拦下（不泄露参数校验细节）', async () => {
		const app = createApp(true, false);
		const response = await app.request('/admin/portal-activity/summary?site=campus');
		assert.equal(response.status, 403);
	});

	it('enabled 端点按开关返回布尔值', async () => {
		const on = await createApp(true, true).request('/admin/portal-activity/enabled');
		const off = await createApp(true, false).request('/admin/portal-activity/enabled');

		assert.equal(on.status, 200);
		assert.deepEqual(await on.json(), { success: true, data: { enabled: true } });
		assert.deepEqual(await off.json(), { success: true, data: { enabled: false } });
	});

	it('开关读取失败按关闭处理（读不到就是没开）', async () => {
		const app = new Hono<AdminEnv>();
		app.use('*', async (c, next) => {
			c.set('principal', { type: 'console' } as never);
			c.set(
				'repositories',
				{
					client: {
						driver: 'postgres',
						raw: {
							unsafe: async () => {
								throw new Error('relation portal_shared.app_config does not exist');
							},
						},
					},
					systemConfig: { getConfig: async () => null },
				} as never
			);
			await next();
		});
		app.route('/admin/portal-activity', adminPortalActivityRoutes);

		const response = await app.request(`/admin/portal-activity/summary?${VALID}`);
		assert.equal(response.status, 403);
	});
});
