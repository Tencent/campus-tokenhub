/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * `request_content` 分区维护任务测试。
 *
 * 三种覆盖：
 * - 纯逻辑（不连库）：月份计算、非 postgres 驱动报错；
 * - 真库集成（需要 DATABASE_URL）：幂等建分区、过期分区被 DROP、锁互斥与释放；
 * - 真库故障注入：某个分区被长事务占住时只跳过它，其它过期分区照常删除。
 *
 * `REQUIRE_PG=1` 时缺 DATABASE_URL 直接失败，避免「无库静默全绿」。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
	createPostgresDatabaseClient,
	type PostgresDatabaseClient,
} from '@octafuse/core/storage/database-client';
import type { GatewayRepositories } from '@octafuse/core';
import { monthKey, runRequestContentMaintenance } from './maintenance';

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const REQUIRE_PG = process.env.REQUIRE_PG === '1';

if (REQUIRE_PG && !DATABASE_URL) {
	throw new Error('REQUIRE_PG=1 但未设置 DATABASE_URL：集成测试不能静默跳过');
}

const skip = DATABASE_URL ? false : 'DATABASE_URL 未设置，跳过 Postgres 集成测试';

const STALE_PARTITION_MONTH = '2020-01-01';
const BLOCKED_PARTITION_MONTH = '2020-02-01';

describe('request content maintenance（纯逻辑）', () => {
	it('monthKey 按自然月前进，跨年正确', () => {
		assert.equal(monthKey(new Date('2026-11-18T10:00:00Z'), 0), '2026-11-01');
		assert.equal(monthKey(new Date('2026-11-18T10:00:00Z'), 1), '2026-12-01');
		assert.equal(monthKey(new Date('2026-12-31T23:00:00Z'), 1), '2027-01-01');
		assert.equal(monthKey(new Date('2026-01-31T23:00:00Z'), 2), '2026-03-01');
	});

	it('非 postgres 驱动直接报错', async () => {
		const fake = { client: { driver: 'd1' } } as unknown as GatewayRepositories;
		await assert.rejects(() => runRequestContentMaintenance(fake), /仅支持 postgres/);
	});
});

describe('request content maintenance（真库）', { skip }, () => {
	let client: PostgresDatabaseClient;
	let repositories: GatewayRepositories;

	async function dropPartitionIfExists(name: string): Promise<void> {
		await client.raw.unsafe(`DROP TABLE IF EXISTS octafuse_gateway.${name}`);
	}

	before(async () => {
		client = await createPostgresDatabaseClient(DATABASE_URL);
		repositories = { client } as unknown as GatewayRepositories;
		// 不依赖迁移预建：用例自己保证被测月份存在
		await client.raw.unsafe('SELECT request_content_ensure_partition($1::date)', ['2026-11-01']);
		await client.raw.unsafe('SELECT request_content_ensure_partition($1::date)', ['2026-12-01']);
	});

	after(async () => {
		await dropPartitionIfExists('request_content_2020_01');
		await dropPartitionIfExists('request_content_2020_02');
		await client.raw.end({ timeout: 5 });
	});

	it('幂等创建当月与下月分区', async () => {
		const first = await runRequestContentMaintenance(repositories, {
			now: new Date('2026-11-18T10:00:00Z'),
		});
		const second = await runRequestContentMaintenance(repositories, {
			now: new Date('2026-11-18T10:00:00Z'),
		});

		assert.equal(first.locked, true);
		assert.deepEqual(first.ensured.sort(), ['request_content_2026_11', 'request_content_2026_12']);
		assert.equal(second.locked, true);
		assert.deepEqual(second.ensured, first.ensured);
	});

	it('早于保留期的分区被整月删除', async () => {
		const created = await client.raw.unsafe(
			'SELECT request_content_ensure_partition($1::date) AS name',
			[STALE_PARTITION_MONTH]
		);
		assert.equal((created[0] as unknown as { name: string }).name, 'request_content_2020_01');

		const outcome = await runRequestContentMaintenance(repositories, { retentionDays: 90 });

		assert.ok(outcome.dropped.includes('request_content_2020_01'));

		const remaining = (await client.raw.unsafe(
			`SELECT child.relname AS name
			 FROM pg_inherits
			 JOIN pg_class parent ON parent.oid = pg_inherits.inhparent
			 JOIN pg_class child ON child.oid = pg_inherits.inhrelid
			 JOIN pg_namespace ns ON ns.oid = parent.relnamespace
			 WHERE ns.nspname = 'octafuse_gateway'
			   AND parent.relname = 'request_content'
			   AND child.relname = 'request_content_2020_01'`
		)) as unknown as { name: string }[];
		assert.equal(remaining.length, 0);
	});

	it('被长事务占住的分区只跳过它，其它过期分区仍被删除', async () => {
		await client.raw.unsafe('SELECT request_content_ensure_partition($1::date)', [
			STALE_PARTITION_MONTH,
		]);
		await client.raw.unsafe('SELECT request_content_ensure_partition($1::date)', [
			BLOCKED_PARTITION_MONTH,
		]);

		const holder = await createPostgresDatabaseClient(DATABASE_URL);
		const reserved = await holder.raw.reserve();
		try {
			await reserved.unsafe('BEGIN');
			await reserved.unsafe(
				'LOCK TABLE octafuse_gateway.request_content_2020_02 IN ACCESS EXCLUSIVE MODE'
			);

			const outcome = await runRequestContentMaintenance(repositories, { retentionDays: 90 });

			assert.equal(outcome.locked, true);
			assert.ok(outcome.dropped.includes('request_content_2020_01'));
			assert.ok(!outcome.dropped.includes('request_content_2020_02'));
		} finally {
			await reserved.unsafe('ROLLBACK');
			reserved.release();
			await holder.raw.end({ timeout: 5 });
		}

		// 释放占用后再跑一轮，被跳过的分区应能被删除
		const second = await runRequestContentMaintenance(repositories, { retentionDays: 90 });
		assert.ok(second.dropped.includes('request_content_2020_02'));
	});

	it('另一实例持锁时本轮跳过，且结束后锁已释放', async () => {
		const holder = await createPostgresDatabaseClient(DATABASE_URL);
		try {
			const locked = await holder.raw.unsafe(
				'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
				['request_content_maintenance']
			);
			assert.equal((locked[0] as unknown as { locked: boolean }).locked, true);

			const outcome = await runRequestContentMaintenance(repositories);

			assert.equal(outcome.locked, false);

			await holder.raw.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [
				'request_content_maintenance',
			]);
		} finally {
			await holder.raw.end({ timeout: 5 });
		}

		// 持有者释放后，另一条连接应能拿到同一把锁 —— 证明上一轮没有泄漏事务级锁
		const probe = await createPostgresDatabaseClient(DATABASE_URL);
		try {
			const acquired = await probe.raw.unsafe(
				'SELECT pg_try_advisory_lock(hashtext($1)) AS locked',
				['request_content_maintenance']
			);
			assert.equal((acquired[0] as unknown as { locked: boolean }).locked, true);
			await probe.raw.unsafe('SELECT pg_advisory_unlock(hashtext($1))', [
				'request_content_maintenance',
			]);
		} finally {
			await probe.raw.end({ timeout: 5 });
		}
	});
});
