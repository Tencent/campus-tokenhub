'use client';

/**
 * 「登录数据统计」功能开关（前端侧）。
 *
 * 开关存在门户库（`portal_shared.app_config.activity_enabled`），后台通过
 * `/api/admin/portal-activity/enabled` 读取。**缺省关闭**：请求失败、超时、
 * 返回体不合预期，一律按关闭处理——否则一次接口抖动就会把「默认不展示」的入口漏出来。
 *
 * 进程内缓存一次请求结果，侧边栏与页面共用，避免每次挂载都打一次接口。
 */

import { useEffect, useState } from 'react';
import { adminApiPath } from '@/lib/admin-browser-path';

let pending: Promise<boolean> | null = null;

async function loadEnabled(): Promise<boolean> {
	try {
		const response = await fetch(adminApiPath('/api/admin/portal-activity/enabled'), {
			headers: { accept: 'application/json' },
		});
		if (!response.ok) return false;
		const payload = (await response.json()) as { data?: { enabled?: unknown } } | null;
		return payload?.data?.enabled === true;
	} catch {
		return false;
	}
}

/** `null` 表示还在读；调用方应把 `null` 当成「暂不展示」 */
export function useActivityEnabled(): boolean | null {
	const [enabled, setEnabled] = useState<boolean | null>(null);

	useEffect(() => {
		pending ??= loadEnabled();
		let alive = true;
		void pending.then((value) => {
			if (alive) setEnabled(value);
		});
		return () => {
			alive = false;
		};
	}, []);

	return enabled;
}

/** 测试与登出后重置缓存 */
export function resetActivityEnabledCache(): void {
	pending = null;
}
