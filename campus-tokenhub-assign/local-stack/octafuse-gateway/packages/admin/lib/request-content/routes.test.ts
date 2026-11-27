/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文详情接口的边界测试（用 fake repositories，不连库）。
 *
 * 锁定四类不碰真实数据就能判定的行为：
 * - 未认证 401；
 * - 非 PostgreSQL 501；
 * - 日志不存在 404；
 * - 日志存在但正文缺失 → 200 + missing（不能返回 404）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { adminRequestContentRoutes } from './routes';

const CREATED_AT = '2026-11-18T10:00:00.000Z';

function createApp(options: {
	withPrincipal?: boolean;
	driver?: 'postgres' | 'd1';
	logExists?: boolean;
	contentRow?: Record<string, unknown> | null;
} = {}): { app: Hono<AdminEnv>; calls: string[] } {
	const {
		withPrincipal = true,
		driver = 'postgres',
		logExists = true,
		contentRow = null,
	} = options;
	const calls: string[] = [];

	const fakeClient = {
		driver,
		raw: {
			async unsafe(query: string): Promise<unknown> {
				calls.push(query);
				if (query.includes('api_key_request_logs')) {
					return logExists ? [{ created_at: CREATED_AT }] : [];
				}
				if (query.includes('request_content')) {
					return contentRow ? [contentRow] : [];
				}
				return [];
			},
		},
	};

	const app = new Hono<AdminEnv>();
	app.use('*', async (c, next) => {
		if (withPrincipal) {
			c.set('principal', { type: 'console' } as never);
			c.set('repositories', { client: fakeClient } as never);
		}
		await next();
	});
	app.route('/admin/request-logs', adminRequestContentRoutes);
	return { app, calls };
}

test('未认证时返回 401', async () => {
	const { app } = createApp({ withPrincipal: false });
	const response = await app.request('/admin/request-logs/log-1/content');
	assert.equal(response.status, 401);
});

test('非 postgres 驱动返回 501', async () => {
	const { app } = createApp({ driver: 'd1' });
	const response = await app.request('/admin/request-logs/log-1/content');
	assert.equal(response.status, 501);
});

test('日志不存在返回 404', async () => {
	const { app } = createApp({ logExists: false });
	const response = await app.request('/admin/request-logs/log-1/content');
	assert.equal(response.status, 404);
});

test('日志存在但正文行缺失时返回 200 + missing', async () => {
	const { app } = createApp({ contentRow: null });
	const response = await app.request('/admin/request-logs/log-1/content');
	assert.equal(response.status, 200);
	const body = (await response.json()) as { state: string; createdAt: string };
	assert.equal(body.state, 'missing');
	assert.equal(body.createdAt, CREATED_AT);
});

test('正文存在时返回 captured 与服务端时间戳', async () => {
	const { app, calls } = createApp({
		contentRow: {
			request_log_id: 'log-1',
			created_at: CREATED_AT,
			user_id: 'u1',
			model_id: 'm1',
			request_protocol: 'openai',
			request_operation: 'chat',
			status: 'success',
			input_text: 'user: 你好',
			output_text: '你好',
			input_chars: 9,
			output_chars: 2,
			input_truncated: false,
			output_truncated: false,
			schema_version: 1,
		},
	});

	const response = await app.request('/admin/request-logs/log-1/content');

	assert.equal(response.status, 200);
	const body = (await response.json()) as {
		state: string;
		inputText: string;
		outputText: string;
	};
	assert.equal(body.state, 'captured');
	assert.equal(body.inputText, 'user: 你好');
	assert.equal(body.outputText, '你好');
	// 时间戳由服务端从主表读取，不接受客户端传入
	assert.ok(calls[0]?.includes('api_key_request_logs'));
});
