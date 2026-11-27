/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理路由：`/admin/request-logs/:requestLogId/content` — 只读正文详情。
 *
 * 边界（design D8）：
 * - 只接受 `requestLogId`，时间戳由服务端从主表取，避免客户端传错导致跨分区查不到；
 * - 返回派生状态 `captured / truncated / missing`；
 * - 仅 PostgreSQL 支持；不返回任何其他用户的上下文。
 */
import { Hono } from 'hono';
import { createPostgresRequestContentRepository } from '@octafuse/core/db/postgres/request-content';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { buildContentResponse } from './content-response';

export const adminRequestContentRoutes = new Hono<AdminEnv>();

adminRequestContentRoutes.use('*', requireAdminPrincipal);

adminRequestContentRoutes.get('/:requestLogId/content', async (c) => {
	const requestLogId = c.req.param('requestLogId')?.trim();
	if (!requestLogId) {
		return c.json({ error: { code: 'invalid_request', message: '缺少日志 ID' } }, 400);
	}

	const { client } = c.get('repositories');
	if (client.driver !== 'postgres') {
		return c.json(
			{ error: { code: 'unsupported_storage', message: '正文留存仅支持 PostgreSQL' } },
			501
		);
	}

	const rows = (await client.raw.unsafe(
		'SELECT created_at FROM api_key_request_logs WHERE id = $1 LIMIT 1',
		[requestLogId]
	)) as unknown as { created_at: string | Date }[];

	if (rows.length === 0) {
		return c.json({ error: { code: 'not_found', message: '日志不存在' } }, 404);
	}

	const createdAt = new Date(rows[0].created_at).toISOString();
	const repo = createPostgresRequestContentRepository(client);
	const row = await repo.getByRequestLogId(requestLogId, createdAt);

	return c.json(buildContentResponse(row, requestLogId, createdAt));
});
