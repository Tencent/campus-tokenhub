/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户用量只读接口的参数校验测试。
 *
 * 成功路径依赖真实 Postgres（由 scripts/bench-portal-usage.mjs 做端到端验证），
 * 这里只锁定「不碰数据库就能判定的边界」：缺参、非法 UUID、非法 days、未认证。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { adminPortalUsageRoutes } from './routes';

function createApp(withPrincipal = true): Hono<AdminEnv> {
	const app = new Hono<AdminEnv>();
	if (withPrincipal) {
		app.use('*', async (c, next) => {
			c.set('principal', { type: 'console' } as never);
			await next();
		});
	}
	app.route('/admin/portal-usage', adminPortalUsageRoutes);
	return app;
}

const UUID = '11111111-1111-4111-8111-111111111111';

test('缺少 user_id 返回 400', async () => {
	const response = await createApp().request('/admin/portal-usage/summary');
	assert.equal(response.status, 400);
	const body = (await response.json()) as { success: boolean; message: string };
	assert.equal(body.success, false);
	assert.match(body.message, /user_id is required/);
});

test('非法 user_id 返回 400', async () => {
	const response = await createApp().request('/admin/portal-usage/summary?user_id=not-a-uuid');
	assert.equal(response.status, 400);
	const body = (await response.json()) as { message: string };
	assert.match(body.message, /must be a UUID/);
});

test('days 不在白名单内返回 400', async () => {
	const response = await createApp().request(`/admin/portal-usage/summary?user_id=${UUID}&days=14`);
	assert.equal(response.status, 400);
	const body = (await response.json()) as { message: string };
	assert.match(body.message, /days must be one of 1, 3, 7, 30/);
});

test('未认证返回 401', async () => {
	const response = await createApp(false).request(`/admin/portal-usage/summary?user_id=${UUID}`);
	assert.equal(response.status, 401);
});

test('tpm-series 缺少 user_id 返回 400', async () => {
	const response = await createApp().request('/admin/portal-usage/tpm-series');
	assert.equal(response.status, 400);
	const body = (await response.json()) as { message: string };
	assert.match(body.message, /user_id is required/);
});

test('tpm-series 非法 range 返回 400', async () => {
	const response = await createApp().request(
		`/admin/portal-usage/tpm-series?user_id=${UUID}&range=14d`
	);
	assert.equal(response.status, 400);
	const body = (await response.json()) as { message: string };
	assert.match(body.message, /range must be one of 24h, 3d, 7d, 30d/);
});

test('tpm-series 未认证返回 401', async () => {
	const response = await createApp(false).request(
		`/admin/portal-usage/tpm-series?user_id=${UUID}`
	);
	assert.equal(response.status, 401);
});
