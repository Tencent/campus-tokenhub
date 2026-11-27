/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `request_content` 分区维护。
 *
 * 为什么必须早于写入开启（评审 Critical）：正文写入依赖目标月份分区存在，分区缺失会让
 * INSERT 全部失败，并按「只丢正文、不影响计费」策略静默丢弃。因此：
 * - 迁移阶段已预建「当前月 + 未来 3 个月」；
 * - 进程启动后每小时跑一次本任务，幂等补齐当月/下月分区并清理过期分区；
 * - 用**事务级** advisory lock（`pg_try_advisory_xact_lock`）互斥，多副本自动只跑一个。
 *
 * 为什么是事务级而不是会话级：`pg_try_advisory_lock` 绑定连接，而 `client.raw` 是连接池，
 * 加锁与解锁可能落在不同连接上，导致锁泄漏、多副本各自持锁。事务级锁随事务结束自动释放，
 * 且加锁、建分区、删分区在同一事务内，语义自洽。
 *
 * 仅支持 PostgreSQL：分区与 SQL 维护函数只存在于 `migrations-postgres/`。
 */
import type { GatewayRepositories } from '@octafuse/core';

const LOCK_KEY = 'request_content_maintenance';
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const FIRST_DELAY_MS = 30_000;

export type RequestContentMaintenanceOutcome = {
	/** false 表示另一实例持锁，本轮未执行 */
	locked: boolean;
	ensured: string[];
	dropped: string[];
};

/** 业务月键（UTC 自然月），`YYYY-MM-01`。跨年由 Date.UTC 自动进位。 */
export function monthKey(now: Date, offsetMonths: number): string {
	const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1));
	const month = String(base.getUTCMonth() + 1).padStart(2, '0');
	return `${base.getUTCFullYear()}-${month}-01`;
}

function retentionDaysFromEnv(): number {
	const parsed = Number.parseInt(process.env.REQUEST_CONTENT_RETENTION_DAYS ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
}

/**
 * 跑一轮维护：补当月/下月分区 + 清理过期分区。
 *
 * - 未抢到锁时返回 `{ locked: false }`，不报错；
 * - `DROP` 超时由 SQL 函数逐分区容错，只有极端错误才会冒泡并被本函数降级为「本轮未删」；
 * - 调用方可注入 `now` 与 `retentionDays`，便于测试与手工补跑。
 */
export async function runRequestContentMaintenance(
	repositories: GatewayRepositories,
	options: { now?: Date; retentionDays?: number } = {}
): Promise<RequestContentMaintenanceOutcome> {
	const client = repositories.client;
	if (client.driver !== 'postgres') {
		throw new Error('request-content maintenance 仅支持 postgres 存储');
	}

	const now = options.now ?? new Date();
	const retentionDays = options.retentionDays ?? retentionDaysFromEnv();

	return client.raw.begin(async (tx) => {
		const lockRows = (await tx.unsafe(
			'SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',
			[LOCK_KEY]
		)) as unknown as { locked: boolean }[];
		if (lockRows[0]?.locked !== true) {
			return { locked: false, ensured: [], dropped: [] };
		}

		const ensured = new Set<string>();
		for (const offset of [0, 1]) {
			const rows = (await tx.unsafe(
				'SELECT request_content_ensure_partition($1::date) AS name',
				[monthKey(now, offset)]
			)) as unknown as { name: string }[];
			const name = rows[0]?.name;
			if (name) ensured.add(name);
		}

		let dropped: string[] = [];
		try {
			const rows = (await tx.unsafe(
				'SELECT request_content_drop_expired($1::int) AS dropped',
				[retentionDays]
			)) as unknown as { dropped: string[] | null }[];
			dropped = rows[0]?.dropped ?? [];
		} catch (error) {
			console.error(
				'[request-content] 过期分区清理失败（本轮跳过）：',
				error instanceof Error ? error.message : String(error)
			);
		}

		return { locked: true, ensured: [...ensured], dropped };
	});
}

let started = false;

function isDisabled(): boolean {
	return (process.env.REQUEST_CONTENT_MAINTENANCE ?? '').trim().toLowerCase() === 'off';
}

function intervalMs(): number {
	const parsed = Number.parseInt(process.env.REQUEST_CONTENT_MAINTENANCE_INTERVAL_MS ?? '', 10);
	return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : DEFAULT_INTERVAL_MS;
}

async function tick(): Promise<void> {
	try {
		const { resolveAdminStorageContext } = await import('@/lib/storage-context');
		const { repositories } = await resolveAdminStorageContext();
		const outcome = await runRequestContentMaintenance(repositories);
		if (!outcome.locked) return;
		if (outcome.dropped.length > 0 || outcome.ensured.length > 0) {
			console.log(
				`[request-content] 分区维护：确保 ${outcome.ensured.join(',') || '-'}，删除 ${outcome.dropped.join(',') || '-'}`
			);
		}
	} catch (error) {
		console.error(
			'[request-content] 分区维护失败：',
			error instanceof Error ? error.message : String(error)
		);
	}
}

/** 幂等启动；重复调用无副作用。 */
export function maybeStartRequestContentMaintenanceWorker(): void {
	if (started || isDisabled()) return;
	started = true;

	const first = setTimeout(() => void tick(), FIRST_DELAY_MS);
	first.unref?.();

	const timer = setInterval(() => void tick(), intervalMs());
	timer.unref?.();

	console.log('[request-content] 分区维护任务已启动');
}
