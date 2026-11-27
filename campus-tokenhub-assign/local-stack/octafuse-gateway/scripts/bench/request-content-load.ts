/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `request_content` 写入压测（直连 PostgreSQL，不走网关转发）。
 *
 * 用途：验证批量写入的延迟与 WAL 增量是否符合 design 的验收标准
 * （P95 增量 < 5%、WAL 峰值 < 150 KB/s、`n_dead_tup` 收敛）。
 *
 * 安全：默认 dry-run 只打印计划；真正写库必须显式 `--allow-write`。
 *
 * 用法：
 *   npx tsx scripts/bench/request-content-load.ts --dry-run
 *   DATABASE_URL=... npx tsx scripts/bench/request-content-load.ts --qps 52 --seconds 60 --allow-write
 */
import { createPostgresDatabaseClient } from '../../packages/core/src/storage/database-client';
import { createPostgresRequestContentRepository } from '../../packages/core/src/db/postgres/request-content.impl';

type Options = {
	qps: number;
	seconds: number;
	batchSize: number;
	payloadChars: number;
	allowWrite: boolean;
	dryRun: boolean;
};

function parseOptions(argv: string[]): Options {
	const pick = (name: string, fallback: number): number => {
		const index = argv.indexOf(name);
		if (index === -1) return fallback;
		const parsed = Number.parseInt(argv[index + 1] ?? '', 10);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	};
	return {
		qps: pick('--qps', 52),
		seconds: pick('--seconds', 10),
		batchSize: pick('--batch-size', 50),
		payloadChars: pick('--payload-chars', 2_200),
		allowWrite: argv.includes('--allow-write'),
		dryRun: argv.includes('--dry-run') || !argv.includes('--allow-write'),
	};
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
	return sorted[index];
}

async function main(): Promise<void> {
	const options = parseOptions(process.argv.slice(2));
	const total = options.qps * options.seconds;
	const payload = 'x'.repeat(options.payloadChars);

	console.log(
		`[bench] qps=${options.qps} seconds=${options.seconds} total=${total} batch=${options.batchSize} chars=${options.payloadChars} dryRun=${options.dryRun} allowWrite=${options.allowWrite}`
	);

	if (options.dryRun) {
		console.log('[bench] dry-run：未写库。加 --allow-write 才会真正插入。');
		return;
	}

	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error('DATABASE_URL is required');
	}

	const client = await createPostgresDatabaseClient(databaseUrl);
	const repo = createPostgresRequestContentRepository(client);
	const runId = `bench-${Date.now()}`;
	const latencies: number[] = [];
	let inserted = 0;

	const walStart = (await client.raw.unsafe(
		"SELECT pg_current_wal_lsn()::text AS lsn"
	)) as unknown as { lsn: string }[];

	const startedAt = Date.now();
	const intervalMs = 1000 / options.qps;

	for (let index = 0; index < total; index += 1) {
		const scheduledAt = startedAt + index * intervalMs;
		const waitMs = scheduledAt - Date.now();
		if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

		const rowStart = Date.now();
		await repo.insertBatch([
			{
				requestLogId: `${runId}-${index}`,
				createdAt: new Date().toISOString(),
				userId: 'bench-user',
				modelId: 'bench-model',
				requestProtocol: 'openai',
				requestOperation: 'chat',
				status: 'success',
				inputText: payload,
				outputText: payload,
				inputChars: options.payloadChars,
				outputChars: options.payloadChars,
				inputTruncated: false,
				outputTruncated: false,
			},
		]);
		latencies.push(Date.now() - rowStart);
		inserted += 1;
	}

	const elapsedMs = Date.now() - startedAt;
	latencies.sort((a, b) => a - b);

	const walEnd = (await client.raw.unsafe(
		"SELECT pg_current_wal_lsn()::text AS lsn"
	)) as unknown as { lsn: string }[];
	const walBytes = (await client.raw.unsafe(
		'SELECT pg_wal_lsn_diff($1::pg_lsn, $2::pg_lsn)::bigint AS bytes',
		[walEnd[0].lsn, walStart[0].lsn]
	)) as unknown as { bytes: string }[];

	const deadTuples = (await client.raw.unsafe(
		`SELECT COALESCE(n_dead_tup, 0)::bigint AS dead
		 FROM pg_stat_user_tables
		 WHERE schemaname = 'octafuse_gateway' AND relname = 'request_content'`
	)) as unknown as { dead: string }[];

	console.log(
		[
			`[bench] 完成 inserted=${inserted} elapsed=${elapsedMs}ms`,
			`P50=${percentile(latencies, 50)}ms P95=${percentile(latencies, 95)}ms P99=${percentile(latencies, 99)}ms`,
			`WAL=${Number(walBytes[0]?.bytes ?? 0)} bytes (~${Math.round(Number(walBytes[0]?.bytes ?? 0) / (elapsedMs / 1000) / 1024)} KB/s)`,
			`n_dead_tup=${deadTuples[0]?.dead ?? '0'}`,
		].join(' | ')
	);

	await client.raw.unsafe('DELETE FROM request_content WHERE request_log_id LIKE $1', [`${runId}%`]);
	await client.raw.end({ timeout: 5 });
}

void main().catch((error) => {
	console.error('[bench] 失败：', error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
