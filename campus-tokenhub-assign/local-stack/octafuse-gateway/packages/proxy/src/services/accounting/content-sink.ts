/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文写入队列（ContentSink）。
 *
 * 三条不可妥协的约束（design D5）：
 * - **不入扣费事务**：正文是追加型旁路写入，与 `insertRequestUsageAndChargeTx` 完全隔离；
 * - **不影响请求路径**：`enqueue` 不 await、不抛错，队列满即丢弃并计数；
 * - **仅 Node 运行时**：Cloudflare Worker 的 isolate 会随时终止，内存队列既无法 drain 也会静默丢数据。
 *
 * 写入失败只记日志（不含正文），由结构化容量日志暴露丢弃/失败计数。
 */
import type { CapturedContent } from '@octafuse/core';

export type ContentSinkItem = {
	requestLogId: string;
	/** 必须与 `api_key_request_logs.created_at` 完全相同 */
	createdAt: string;
	userId?: string | null;
	modelId?: string | null;
	requestProtocol?: string | null;
	requestOperation?: string | null;
	status?: string | null;
	content: CapturedContent;
};

export type ContentSinkRow = {
	requestLogId: string;
	createdAt: string;
	userId: string | null;
	modelId: string | null;
	requestProtocol: string | null;
	requestOperation: string | null;
	status: string | null;
	inputText: string;
	outputText: string;
	inputChars: number;
	outputChars: number;
	inputTruncated: boolean;
	outputTruncated: boolean;
};

/** 存储侧最小接口：`createPostgresRequestContentRepository` 的 `insertBatch` 即可直接传入。 */
export type ContentSinkTarget = {
	insertBatch(rows: ContentSinkRow[]): Promise<number>;
};

export type ContentSinkStats = {
	enqueued: number;
	dropped: number;
	inserted: number;
	failedBatches: number;
	queueDepth: number;
};

export type ContentSinkOptions = {
	batchSize?: number;
	flushMs?: number;
	maxQueue?: number;
	isEnabled?: () => boolean;
	now?: () => number;
	/** 容量日志间隔，默认 5 分钟；测试可调小或关闭 */
	capacityLogIntervalMs?: number;
};

export type ContentSink = {
	enqueue(item: ContentSinkItem): void;
	/** 立即写入一批（主要给测试与 drain 用） */
	flush(): Promise<void>;
	/** 进程退出前尽力写空队列（最多 3 秒） */
	drain(): Promise<void>;
	stop(): void;
	stats(): ContentSinkStats;
};

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 500;
const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_CAPACITY_LOG_INTERVAL_MS = 5 * 60 * 1000;
const DRAIN_TIMEOUT_MS = 3_000;

function envInt(name: string, fallback: number): number {
	const parsed = Number.parseInt(process.env[name] ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 默认开关：显式 off 关闭；非 Node 运行时（Cloudflare Worker）自动关闭。 */
export function isContentCaptureEnabled(): boolean {
	if ((process.env.REQUEST_CONTENT_CAPTURE ?? '').trim().toLowerCase() === 'off') return false;
	return typeof process !== 'undefined' && Boolean(process.versions?.node);
}

function toRow(item: ContentSinkItem): ContentSinkRow {
	return {
		requestLogId: item.requestLogId,
		createdAt: item.createdAt,
		userId: item.userId ?? null,
		modelId: item.modelId ?? null,
		requestProtocol: item.requestProtocol ?? null,
		requestOperation: item.requestOperation ?? null,
		status: item.status ?? null,
		inputText: item.content.inputText,
		outputText: item.content.outputText,
		inputChars: item.content.inputChars,
		outputChars: item.content.outputChars,
		inputTruncated: item.content.inputTruncated,
		outputTruncated: item.content.outputTruncated,
	};
}

export function createContentSink(
	target: ContentSinkTarget,
	options: ContentSinkOptions = {}
): ContentSink {
	const batchSize = options.batchSize ?? envInt('REQUEST_CONTENT_BATCH_SIZE', DEFAULT_BATCH_SIZE);
	const flushMs = options.flushMs ?? envInt('REQUEST_CONTENT_FLUSH_MS', DEFAULT_FLUSH_MS);
	const maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
	const isEnabled = options.isEnabled ?? isContentCaptureEnabled;
	const now = options.now ?? (() => Date.now());
	const capacityLogIntervalMs =
		options.capacityLogIntervalMs ?? DEFAULT_CAPACITY_LOG_INTERVAL_MS;

	const queue: ContentSinkRow[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	let flushing: Promise<void> | null = null;
	let lastCapacityLogAt = 0;

	const stats: ContentSinkStats = {
		enqueued: 0,
		dropped: 0,
		inserted: 0,
		failedBatches: 0,
		queueDepth: 0,
	};

	function clearTimer(): void {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
	}

	function maybeLogCapacity(): void {
		if (capacityLogIntervalMs <= 0) return;
		const at = now();
		if (at - lastCapacityLogAt < capacityLogIntervalMs) return;
		lastCapacityLogAt = at;
		// 只打计数，不打正文
		console.log(
			`[request-content] 容量统计 enqueued=${stats.enqueued} inserted=${stats.inserted} dropped=${stats.dropped} failedBatches=${stats.failedBatches} queueDepth=${queue.length}`
		);
	}

	function schedule(): void {
		if (timer || queue.length === 0 || !isEnabled()) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, flushMs);
		timer.unref?.();
	}

	async function flush(): Promise<void> {
		if (flushing) {
			await flushing;
			return;
		}
		if (queue.length === 0) return;

		const batch = queue.splice(0, batchSize);
		flushing = (async () => {
			try {
				stats.inserted += await target.insertBatch(batch);
			} catch (error) {
				stats.failedBatches += 1;
				console.error(
					'[request-content] 正文写入失败：',
					error instanceof Error ? error.message : String(error)
				);
			}
		})();

		try {
			await flushing;
		} finally {
			flushing = null;
			stats.queueDepth = queue.length;
			maybeLogCapacity();
			if (queue.length > 0) schedule();
		}
	}

	return {
		enqueue(item: ContentSinkItem): void {
			if (!isEnabled()) return;
			if (queue.length >= maxQueue) {
				stats.dropped += 1;
				return;
			}
			queue.push(toRow(item));
			stats.enqueued += 1;
			stats.queueDepth = queue.length;

			if (queue.length >= batchSize) {
				clearTimer();
				void flush();
				return;
			}
			schedule();
		},

		async flush(): Promise<void> {
			await flush();
		},

		async drain(): Promise<void> {
			clearTimer();
			const deadline = now() + DRAIN_TIMEOUT_MS;
			while (queue.length > 0 && now() < deadline) {
				await flush();
			}
			if (flushing) await flushing;
		},

		stop(): void {
			clearTimer();
		},

		stats(): ContentSinkStats {
			return { ...stats, queueDepth: queue.length };
		},
	};
}
