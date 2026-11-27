/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Postgres `request_content` 旁路表集成测试（真库）。
 *
 * 需要 `DATABASE_URL`；未设置时整体跳过，保证无 PG 环境（CI）下 `test:unit` 不红。
 * 覆盖：批量幂等、复合主键点查、跨月边界分区、记账 INSERT 的 created_at 显式写入。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
	createPostgresDatabaseClient,
	type PostgresDatabaseClient,
} from '../../storage/database-client';
import { insertRequestUsageAndChargeTxPg } from './critical-writes.impl';
import {
	createPostgresRequestContentRepository,
	type RequestContentInsert,
} from './request-content.impl';
import type { InsertRequestLogParams } from '../request-logs-types';

const DATABASE_URL = process.env.DATABASE_URL?.trim() ?? '';
const REQUIRE_PG = process.env.REQUIRE_PG === '1';

if (REQUIRE_PG && !DATABASE_URL) {
	throw new Error('REQUIRE_PG=1 但未设置 DATABASE_URL：集成测试不能静默跳过');
}

const skip = DATABASE_URL ? false : 'DATABASE_URL 未设置，跳过 Postgres 集成测试';

const ID_PREFIX = 'test-rc-';

function contentRow(overrides: Partial<RequestContentInsert> = {}): RequestContentInsert {
	return {
		requestLogId: `${ID_PREFIX}1`,
		createdAt: '2026-11-15T10:00:00.000Z',
		userId: `${ID_PREFIX}user`,
		modelId: 'gpt-test',
		requestProtocol: 'openai',
		requestOperation: 'chat',
		status: 'success',
		inputText: '你好',
		outputText: '世界',
		inputChars: 2,
		outputChars: 2,
		inputTruncated: false,
		outputTruncated: false,
		...overrides,
	};
}

function requestLogParams(overrides: Partial<InsertRequestLogParams> = {}): InsertRequestLogParams {
	return {
		id: `${ID_PREFIX}log`,
		userId: `${ID_PREFIX}user`,
		apiKeyId: `${ID_PREFIX}key`,
		userEmail: 'test-rc@example.com',
		modelId: 'gpt-test',
		providerId: 'provider-test',
		providerModelName: null,
		modelName: null,
		providerName: null,
		requestBody: null,
		upstreamRequestBody: null,
		requestProtocol: 'openai',
		requestOperation: 'chat',
		upstreamProtocol: 'openai',
		upstreamOperation: null,
		inputTokens: 1,
		outputTokens: 1,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		totalTokens: 2,
		meteredCost: 0,
		standardCost: 0,
		chargedCost: 0,
		routeGroup: 'default',
		status: 'success',
		latencyMs: 12,
		errorMessage: null,
		rawUsage: null,
		...overrides,
	};
}

describe('request_content repository', { skip }, () => {
	let client: PostgresDatabaseClient;
	let repo: ReturnType<typeof createPostgresRequestContentRepository>;

	before(async () => {
		client = await createPostgresDatabaseClient(DATABASE_URL);
		repo = createPostgresRequestContentRepository(client);
		// 用例固定用 2026-11 / 2026-12 的边界，自己保证分区存在，不依赖迁移预建
		await repo.ensurePartition('2026-11-01');
		await repo.ensurePartition('2026-12-01');
		await client.raw.unsafe('DELETE FROM request_content WHERE request_log_id LIKE $1', [
			`${ID_PREFIX}%`,
		]);
	});

	after(async () => {
		await client.raw.unsafe('DELETE FROM request_content WHERE request_log_id LIKE $1', [
			`${ID_PREFIX}%`,
		]);
		await client.raw.unsafe('DELETE FROM api_key_request_logs WHERE id LIKE $1', [`${ID_PREFIX}%`]);
		await client.raw.unsafe('DELETE FROM api_keys WHERE id LIKE $1', [`${ID_PREFIX}%`]);
		await client.raw.unsafe('DELETE FROM users WHERE id LIKE $1', [`${ID_PREFIX}%`]);
		await client.raw.end({ timeout: 5 });
	});

	it('批量插入幂等：重复批次被 ON CONFLICT DO NOTHING 忽略', async () => {
		const rows = [contentRow(), contentRow({ requestLogId: `${ID_PREFIX}2` })];

		const first = await repo.insertBatch(rows);
		const second = await repo.insertBatch(rows);

		assert.equal(first, 2);
		assert.equal(second, 0);
	});

	it('按复合主键点查命中单行', async () => {
		const target = contentRow({ requestLogId: `${ID_PREFIX}3`, createdAt: '2026-11-16T09:30:00.000Z' });
		const inserted = await repo.insertBatch([target]);
		assert.equal(inserted, 1);

		const found = await repo.getByRequestLogId(target.requestLogId, target.createdAt);

		assert.ok(found);
		assert.equal(found?.input_text, '你好');
		assert.equal(found?.output_text, '世界');
		assert.equal(found?.input_truncated, false);
		assert.equal(found?.created_at, target.createdAt);
	});

	it('created_at 不精确时查不到（复合主键语义）', async () => {
		const target = contentRow({ requestLogId: `${ID_PREFIX}4`, createdAt: '2026-11-16T11:00:00.000Z' });
		await repo.insertBatch([target]);

		const found = await repo.getByRequestLogId(target.requestLogId, '2026-11-16T11:00:01.000Z');

		assert.equal(found, null);
	});

	it('跨月边界分别落入相邻分区且各自可查', async () => {
		const november = contentRow({
			requestLogId: `${ID_PREFIX}nov`,
			createdAt: '2026-11-30T23:59:59.999Z',
			outputText: 'nov',
		});
		const december = contentRow({
			requestLogId: `${ID_PREFIX}dec`,
			createdAt: '2026-12-01T00:00:00.001Z',
			outputText: 'dec',
		});
		await repo.insertBatch([november, december]);

		const novFound = await repo.getByRequestLogId(november.requestLogId, november.createdAt);
		const decFound = await repo.getByRequestLogId(december.requestLogId, december.createdAt);

		assert.equal(novFound?.output_text, 'nov');
		assert.equal(decFound?.output_text, 'dec');

		const partitions = (await client.raw.unsafe(
			`SELECT tableoid::regclass::text AS part, request_log_id
			 FROM request_content
			 WHERE request_log_id IN ($1, $2)`,
			[november.requestLogId, december.requestLogId]
		)) as { part: string; request_log_id: string }[];
		const byId = new Map(partitions.map((row) => [row.request_log_id, row.part]));
		assert.match(byId.get(november.requestLogId) ?? '', /2026_11/);
		assert.match(byId.get(december.requestLogId) ?? '', /2026_12/);
	});

	it('回归：记账 INSERT 使用调用方传入的 created_at，而非数据库当前时间', async () => {
		const createdAt = '2026-11-10T06:00:00.000Z';
		await client.raw.unsafe(
			'INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
			[`${ID_PREFIX}user`, 'test-rc@example.com']
		);
		await client.raw.unsafe(
			'INSERT INTO api_keys (id, key, user_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
			[`${ID_PREFIX}key`, `sk-${ID_PREFIX}key`, `${ID_PREFIX}user`]
		);

		await insertRequestUsageAndChargeTxPg(client, {
			requestLog: requestLogParams({ createdAt }),
			shouldChargeBudget: false,
			userId: `${ID_PREFIX}user`,
			beforeSpent: 0,
			chargedCost: 0,
			audit: {
				apiKeyId: `${ID_PREFIX}key`,
				eventType: 'usage_charge',
				actorType: 'system',
				beforeSpent: 0,
			},
		});

		const rows = (await client.raw.unsafe(
			'SELECT created_at FROM api_key_request_logs WHERE id = $1',
			[`${ID_PREFIX}log`]
		)) as { created_at: Date }[];

		assert.equal(rows.length, 1);
		assert.equal(new Date(rows[0].created_at).toISOString(), createdAt);
	});
});
