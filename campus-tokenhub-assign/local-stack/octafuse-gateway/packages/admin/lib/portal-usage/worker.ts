/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 门户用量补算任务（独立模块）。
 *
 * 设计要点：
 * - 只在 Node 自托管入口启动（Cloudflare 部署无此入口，且本模块仅支持 Postgres）；
 * - `PORTAL_USAGE_WORKER=off` 关闭；
 * - 每轮先抢 advisory lock，多副本/误开第二个进程时直接跳过，不排队抢水位行锁；
 * - 单轮窗口由 service 控制（默认 5 分钟），异常只记日志，不抛出到主进程。
 */
import { resolveAdminStorageContext } from '@/lib/storage-context';
import {
	releasePortalUsageLock,
	runPortalUsageBackfill,
	tryPortalUsageLock,
} from './service';

const DEFAULT_INTERVAL_MS = 60_000;
const FIRST_DELAY_MS = 5_000;

let started = false;

function intervalMs(): number {
	const raw = process.env.PORTAL_USAGE_INTERVAL_MS?.trim();
	const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 10_000 ? parsed : DEFAULT_INTERVAL_MS;
}

function isDisabled(): boolean {
	return (process.env.PORTAL_USAGE_WORKER ?? '').trim().toLowerCase() === 'off';
}

async function tick(): Promise<void> {
	let locked = false;
	try {
		const { repositories } = await resolveAdminStorageContext();
		locked = await tryPortalUsageLock(repositories);
		if (!locked) return;

		const outcome = await runPortalUsageBackfill(repositories);
		if (outcome.scannedRows > 0) {
			console.log(
				`[portal-usage] 补算 ${outcome.from} → ${outcome.to}（tz=${outcome.tz}），扫描 ${outcome.scannedRows} 行`
			);
		}
	} catch (error) {
		console.error('[portal-usage] 补算失败：', error instanceof Error ? error.message : String(error));
	} finally {
		if (locked) {
			try {
				const { repositories } = await resolveAdminStorageContext();
				await releasePortalUsageLock(repositories);
			} catch {
				// 释放失败不阻塞下一轮：连接断开时锁会随会话结束自动释放
			}
		}
	}
}

/** 幂等启动；重复调用无副作用 */
export function maybeStartPortalUsageWorker(): void {
	if (started || isDisabled()) return;
	started = true;

	const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
	first.unref?.();

	const timer = setInterval(() => void tick(), intervalMs());
	timer.unref?.();

	console.log('[portal-usage] 补算任务已启动');
}
