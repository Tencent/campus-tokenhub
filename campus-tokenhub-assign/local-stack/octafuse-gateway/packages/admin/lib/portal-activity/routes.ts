/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-27.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 管理路由：`/admin/portal-activity/*` — 门户活跃度看板的只读聚合接口。
 *
 * 独立模块，只读 `portal_shared` 的两张事件表；不提供任何写操作。
 * 参数在进数据库前全部校验：日期格式与跨度、站点、排序、上限。
 */

import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { requireAdminPrincipal } from '@/lib/middleware/admin-auth';
import { handleAdminRouteError } from '@/lib/routes/admin/error-response';
import {
	ACTIVITY_SITES,
	ACTIVITY_SORTS,
	MAX_LIMIT,
	MAX_RANGE_DAYS,
	normalizeRange,
	parseLimit,
	parseSite,
	parseSort,
	isPortalActivityEnabled,
	queryPortalActivitySummary,
} from './service';

export const adminPortalActivityRoutes = new Hono<AdminEnv>();

adminPortalActivityRoutes.use('*', requireAdminPrincipal);

// 前端用它决定「分析 → 登录数据」入口是否展示；刻意不缓存，关掉开关后刷新即生效
adminPortalActivityRoutes.get('/enabled', async (c) => {
	try {
		const enabled = await isPortalActivityEnabled(c.get('repositories'));
		return c.json({ success: true, data: { enabled } });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to resolve portal activity switch');
	}
});

adminPortalActivityRoutes.get('/summary', async (c) => {
	try {
		// 功能关闭时整条链路都不应产出数据：403 而不是空结果，避免被误读为「这段时间没人用」
		if (!(await isPortalActivityEnabled(c.get('repositories')))) {
			return c.json(
				{
					success: false,
					code: 'feature_disabled',
					message: '登录数据统计未开启，请在门户「设置 → 首页配置」中启用',
				},
				403
			);
		}

		const range = normalizeRange(
			(c.req.query('start_date') ?? '').trim(),
			(c.req.query('end_date') ?? '').trim()
		);
		if (!range) {
			return c.json(
				{
					success: false,
					message: `start_date / end_date 需为 YYYY-MM-DD，且跨度不超过 ${MAX_RANGE_DAYS} 天`,
				},
				400
			);
		}

		const site = parseSite(c.req.query('site'));
		if (!site) {
			return c.json({ success: false, message: `site 需为 ${ACTIVITY_SITES.join(' / ')}` }, 400);
		}

		const sort = parseSort(c.req.query('sort'));
		if (!sort) {
			return c.json({ success: false, message: `sort 需为 ${ACTIVITY_SORTS.join(' / ')}` }, 400);
		}

		const limit = parseLimit(c.req.query('limit'));
		if (limit === null) {
			return c.json({ success: false, message: `limit 需为 1~${MAX_LIMIT} 的整数` }, 400);
		}

		const q = (c.req.query('q') ?? '').trim().slice(0, 100);

		const data = await queryPortalActivitySummary(c.get('repositories'), {
			...range,
			site,
			sort,
			q,
			limit,
		});

		return c.json({ success: true, data });
	} catch (error) {
		return handleAdminRouteError(c, error, 'Failed to get portal activity summary');
	}
});
