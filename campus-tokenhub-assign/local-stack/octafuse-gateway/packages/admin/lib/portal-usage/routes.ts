/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理路由：`/admin/portal-usage/*` — 门户数据看板的只读聚合接口。
 *
 * 独立模块，只读汇总表；不提供任何写操作，也不返回 user_email 等跨用户信息。
 */
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from '@/lib/routes/admin/error-response';
import {
	queryPortalUsageSummary,
	queryPortalUsageTpmSeries,
	SUPPORTED_DAYS,
	TPM_RANGES,
	type SupportedDays,
	type TpmRange,
} from './service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseDays(raw: string | undefined): SupportedDays | null {
	if (raw == null || raw.trim() === '') return 7;
	const parsed = Number.parseInt(raw, 10);
	return (SUPPORTED_DAYS as readonly number[]).includes(parsed) ? (parsed as SupportedDays) : null;
}

function parseTpmRange(raw: string | undefined): TpmRange | null {
	if (raw == null || raw.trim() === '') return '24h';
	const value = raw.trim();
	return (TPM_RANGES as readonly string[]).includes(value) ? (value as TpmRange) : null;
}

export const adminPortalUsageRoutes = new Hono<AdminEnv>();

adminPortalUsageRoutes.use('*', requireAdminPrincipal);

adminPortalUsageRoutes.get('/summary', async (c) => {
	try {
		const userIdRaw = (c.req.query('user_id') ?? '').trim();
		if (!userIdRaw) {
			return c.json({ success: false, message: 'user_id is required' }, 400);
		}
		if (!UUID_PATTERN.test(userIdRaw)) {
			return c.json({ success: false, message: 'user_id must be a UUID' }, 400);
		}

		const days = parseDays(c.req.query('days'));
		if (days === null) {
			return c.json(
				{ success: false, message: `days must be one of ${SUPPORTED_DAYS.join(', ')}` },
				400
			);
		}

		const repositories = c.get('repositories');
		const data = await queryPortalUsageSummary(repositories, userIdRaw, days);
		return c.json({ success: true, data });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to get portal usage summary');
	}
});

/**
 * 按模型 × 自适应分桶的峰值 TPM 序列（门户「算力使用汇总」）。
 *
 * 与 `/summary` 分开的原因：summary 读的是按天预聚合表，分钟级吞吐必须回明细表；
 * 两者索引与查询代价完全不同，合并成一个接口只会让看板首屏互相拖慢。
 */
adminPortalUsageRoutes.get('/tpm-series', async (c) => {
	try {
		const userIdRaw = (c.req.query('user_id') ?? '').trim();
		if (!userIdRaw) {
			return c.json({ success: false, message: 'user_id is required' }, 400);
		}
		if (!UUID_PATTERN.test(userIdRaw)) {
			return c.json({ success: false, message: 'user_id must be a UUID' }, 400);
		}

		const range = parseTpmRange(c.req.query('range'));
		if (range === null) {
			return c.json(
				{ success: false, message: `range must be one of ${TPM_RANGES.join(', ')}` },
				400
			);
		}

		const repositories = c.get('repositories');
		const data = await queryPortalUsageTpmSeries(repositories, userIdRaw, range);
		return c.json({ success: true, data });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to get portal usage tpm series');
	}
});
