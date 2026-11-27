/*
 * Modified by the campus-tokenhub project (Tencent), 2026-11-24.
 * This file is part of a modified OctaFuse Gateway; see MODIFICATIONS.md.
 */

/**
 * 正文捕获开销基准（不经过网络与网关，只测解析 + 累积的 CPU 成本）。
 *
 * 用途：回答「开启捕获后每个 SSE 帧多花多少」。
 * 端到端 P95 对比需要网关实例与可用上游，由 6.2 的部署环境压测补充。
 *
 * 用法：npx tsx scripts/bench/request-content-capture-overhead.ts [--frames 200000]
 */
import { EMPTY_USAGE } from '../../packages/proxy/src/services/proxy';
import { createCaptureAccumulator } from '../../packages/proxy/src/services/content-capture/accumulate';
import { extractStreamDelta } from '../../packages/proxy/src/services/content-capture/extract';
import { processResponsesDataLine } from '../../packages/proxy/src/services/egress/openai-responses-driver';

const DELTA_LINE =
	'data: {"type":"response.output_text.delta","delta":"这是一段用于压测的模型输出文本，长度接近真实场景。"}';

function framesFromArgv(): number {
	const index = process.argv.indexOf('--frames');
	const parsed = index === -1 ? Number.NaN : Number.parseInt(process.argv[index + 1] ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 200_000;
}

function runWithoutCapture(frames: number): number {
	const usage = { ...EMPTY_USAGE };
	const startedAt = performance.now();
	for (let index = 0; index < frames; index += 1) {
		processResponsesDataLine(DELTA_LINE, usage);
	}
	return performance.now() - startedAt;
}

function runWithCapture(frames: number): number {
	const usage = { ...EMPTY_USAGE };
	const accumulator = createCaptureAccumulator();
	const startedAt = performance.now();
	for (let index = 0; index < frames; index += 1) {
		processResponsesDataLine(DELTA_LINE, usage, undefined, (parsed) => {
			const delta = extractStreamDelta('responses', parsed);
			if (delta) accumulator.append(delta);
		});
	}
	const elapsed = performance.now() - startedAt;
	accumulator.finish();
	return elapsed;
}

function main(): void {
	const frames = framesFromArgv();

	// 预热，避免 JIT 把第一次运行算进结果
	runWithoutCapture(Math.min(frames, 20_000));
	runWithCapture(Math.min(frames, 20_000));

	const baseline = runWithoutCapture(frames);
	const captured = runWithCapture(frames);

	const perFrameBase = (baseline * 1000) / frames;
	const perFrameCaptured = (captured * 1000) / frames;
	const deltaPercent = ((captured - baseline) / baseline) * 100;

	console.log(
		[
			`[bench] frames=${frames}`,
			`baseline=${baseline.toFixed(0)}ms (${perFrameBase.toFixed(2)}µs/帧)`,
			`capture=${captured.toFixed(0)}ms (${perFrameCaptured.toFixed(2)}µs/帧)`,
			`增量=${deltaPercent.toFixed(1)}%`,
		].join(' | ')
	);
}

main();
