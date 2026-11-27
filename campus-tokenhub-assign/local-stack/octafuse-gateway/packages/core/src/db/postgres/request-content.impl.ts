/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * Postgres：`request_content` 旁路分区表（postgres.js + unsafe）。
 *
 * 三条使用约束（与 `migrations-postgres/0037_request_content.sql` 对齐）：
 * - 批量写入只 INSERT + `ON CONFLICT DO NOTHING`，永不 UPDATE，避免死元组；
 * - `createdAt` 必须与 `api_key_request_logs.created_at` 完全相同，否则点查跨分区落空；
 * - 分区按月（UTC），续建与过期清理分别走 SQL 函数，不在应用侧拼 DDL。
 */
import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { RequestContentRow } from '../../types';

/** 待写入的一行正文。文本为规范化结果，调用方已完成脱敏与截断。 */
export type RequestContentInsert = {
	requestLogId: string;
	/** ISO 字符串；须与 `api_key_request_logs.created_at` 一致 */
	createdAt: string;
	userId?: string | null;
	modelId?: string | null;
	requestProtocol?: string | null;
	requestOperation?: string | null;
	status?: string | null;
	inputText?: string | null;
	outputText?: string | null;
	inputChars?: number | null;
	outputChars?: number | null;
	inputTruncated?: boolean;
	outputTruncated?: boolean;
};

const INSERT_COLUMNS = [
	'request_log_id',
	'created_at',
	'user_id',
	'model_id',
	'request_protocol',
	'request_operation',
	'status',
	'input_text',
	'output_text',
	'input_chars',
	'output_chars',
	'input_truncated',
	'output_truncated',
] as const;

const SELECT_COLUMNS = [
	...INSERT_COLUMNS,
	'schema_version',
].join(', ');

function mapRow(row: Record<string, unknown>): RequestContentRow {
	return {
		request_log_id: String(row.request_log_id),
		created_at: new Date(row.created_at as string | Date).toISOString(),
		user_id: (row.user_id as string | null) ?? null,
		model_id: (row.model_id as string | null) ?? null,
		request_protocol: (row.request_protocol as string | null) ?? null,
		request_operation: (row.request_operation as string | null) ?? null,
		status: (row.status as string | null) ?? null,
		input_text: (row.input_text as string | null) ?? null,
		output_text: (row.output_text as string | null) ?? null,
		input_chars: row.input_chars == null ? null : Number(row.input_chars),
		output_chars: row.output_chars == null ? null : Number(row.output_chars),
		input_truncated: Boolean(row.input_truncated),
		output_truncated: Boolean(row.output_truncated),
		schema_version: row.schema_version == null ? 1 : Number(row.schema_version),
	};
}

export type RequestContentRepository = {
	/** 批量写入，返回真正插入的行数（冲突跳过的行不计入）。 */
	insertBatch(rows: RequestContentInsert[]): Promise<number>;
	/** 按复合主键点查；`createdAt` 必须与写入值完全一致。 */
	getByRequestLogId(requestLogId: string, createdAt: string): Promise<RequestContentRow | null>;
	/** 幂等创建指定月份分区；`month` 为 `YYYY-MM-DD`（该月任意一天）。 */
	ensurePartition(month: string): Promise<string>;
	/** 删除整月早于保留期的分区，返回被删分区名。 */
	dropExpired(retentionDays: number): Promise<string[]>;
};

export function createPostgresRequestContentRepository(
	db: PostgresDatabaseClient
): RequestContentRepository {
	const pg = db.raw;

	return {
		async insertBatch(rows: RequestContentInsert[]): Promise<number> {
			if (rows.length === 0) return 0;

			const placeholders: string[] = [];
			const params: unknown[] = [];
			for (const [index, row] of rows.entries()) {
				const base = index * INSERT_COLUMNS.length;
				const slots = INSERT_COLUMNS.map((_, offset) => `$${base + offset + 1}`);
				placeholders.push(`(${slots.join(', ')})`);
				params.push(
					row.requestLogId,
					row.createdAt,
					row.userId ?? null,
					row.modelId ?? null,
					row.requestProtocol ?? null,
					row.requestOperation ?? null,
					row.status ?? null,
					row.inputText ?? null,
					row.outputText ?? null,
					row.inputChars ?? null,
					row.outputChars ?? null,
					row.inputTruncated ?? false,
					row.outputTruncated ?? false
				);
			}

			const inserted = (await pg.unsafe(
				`INSERT INTO request_content (${INSERT_COLUMNS.join(', ')})
				 VALUES ${placeholders.join(', ')}
				 ON CONFLICT (request_log_id, created_at) DO NOTHING
				 RETURNING request_log_id`,
				params as Parameters<typeof pg.unsafe>[1]
			)) as Record<string, unknown>[];

			return inserted.length;
		},

		async getByRequestLogId(
			requestLogId: string,
			createdAt: string
		): Promise<RequestContentRow | null> {
			const rows = (await pg.unsafe(
				`SELECT ${SELECT_COLUMNS}
				 FROM request_content
				 WHERE request_log_id = $1 AND created_at = $2
				 LIMIT 1`,
				[requestLogId, createdAt]
			)) as Record<string, unknown>[];
			return rows[0] ? mapRow(rows[0]) : null;
		},

		async ensurePartition(month: string): Promise<string> {
			const rows = (await pg.unsafe(
				'SELECT request_content_ensure_partition($1::date) AS name',
				[month]
			)) as { name: string }[];
			return rows[0]?.name ?? '';
		},

		async dropExpired(retentionDays: number): Promise<string[]> {
			const rows = (await pg.unsafe(
				'SELECT request_content_drop_expired($1::int) AS dropped',
				[retentionDays]
			)) as { dropped: string[] | null }[];
			return rows[0]?.dropped ?? [];
		},
	};
}
