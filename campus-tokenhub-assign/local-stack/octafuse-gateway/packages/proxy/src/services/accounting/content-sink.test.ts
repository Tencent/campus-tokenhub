/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * ContentSink：正文写入队列。
 *
 * 设计目标是「绝不影响请求路径」：入队不 await、写入失败只记日志、队列满即丢弃。
 * 测试用注入的 `insertBatch` 替代真实仓储，因此不依赖数据库。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createContentSink, type ContentSinkItem } from './content-sink';

function item(id: string): ContentSinkItem {
	return {
		requestLogId: id,
		createdAt: '2026-11-18T10:00:00.000Z',
		userId: 'u1',
		modelId: 'm1',
		requestProtocol: 'openai',
		requestOperation: 'chat',
		status: 'success',
		content: {
			inputText: '你好',
			outputText: '世界',
			inputChars: 2,
			outputChars: 2,
			inputTruncated: false,
			outputTruncated: false,
		},
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 轮询等待条件成立，避免固定 sleep 在并发负载下不稳定。 */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
}

function fakeTarget() {
	const batches: string[][] = [];
	let failNext = false;
	return {
		batches,
		setFailNext(value: boolean) {
			failNext = value;
		},
		async insertBatch(rows: { requestLogId: string }[]): Promise<number> {
			if (failNext) throw new Error('db down');
			batches.push(rows.map((row) => row.requestLogId));
			return rows.length;
		},
	};
}

describe('createContentSink', () => {
	it('达到批量阈值立即写入', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 2, flushMs: 1_000 });

		sink.enqueue(item('a'));
		assert.equal(target.batches.length, 0);
		sink.enqueue(item('b'));

		await sink.drain();
		assert.deepEqual(target.batches, [['a', 'b']]);
		assert.equal(sink.stats().inserted, 2);
	});

	it('未达阈值时按 flushMs 定时写入', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 100, flushMs: 10 });

		sink.enqueue(item('a'));
		await waitFor(() => target.batches.length > 0);
		await sink.drain();

		assert.deepEqual(target.batches, [['a']]);
	});

	it('队列超过上限时丢弃并计数', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 100, flushMs: 10_000, maxQueue: 2 });

		sink.enqueue(item('a'));
		sink.enqueue(item('b'));
		sink.enqueue(item('c'));

		assert.equal(sink.stats().dropped, 1);
		await sink.drain();
		assert.equal(sink.stats().inserted, 2);
	});

	it('写入失败不抛给调用方，只累计失败批次', async () => {
		const target = fakeTarget();
		target.setFailNext(true);
		const sink = createContentSink(target, { batchSize: 1, flushMs: 10_000 });

		sink.enqueue(item('a'));
		await sink.drain();

		assert.equal(sink.stats().failedBatches, 1);
		assert.equal(sink.stats().inserted, 0);
	});

	it('drain 写完剩余队列', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 10, flushMs: 10_000 });

		for (const id of ['a', 'b', 'c']) sink.enqueue(item(id));
		await sink.drain();

		assert.deepEqual(target.batches.flat(), ['a', 'b', 'c']);
		assert.equal(sink.stats().queueDepth, 0);
	});

	it('关闭后 enqueue 为 no-op', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 1, flushMs: 10, isEnabled: () => false });

		sink.enqueue(item('a'));
		await sink.flush();

		assert.equal(target.batches.length, 0);
		assert.equal(sink.stats().enqueued, 0);
	});

	it('stop 后不再定时触发写入', async () => {
		const target = fakeTarget();
		const sink = createContentSink(target, { batchSize: 100, flushMs: 10 });

		sink.enqueue(item('a'));
		sink.stop();
		await sleep(150);

		assert.equal(target.batches.length, 0);
	});
});
