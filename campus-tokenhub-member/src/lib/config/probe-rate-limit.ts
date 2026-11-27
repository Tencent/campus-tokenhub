/**
 * 探测接口的进程内限流。
 *
 * 独立成模块：route 文件只能导出 HTTP 方法，限流状态与重置函数放在这里，
 * 测试可以直接操作。
 */

const PROBE_INTERVAL_MS = 10_000;

const lastProbeAt = new Map<string, number>();

export class ProbeRateLimitError extends Error {
  readonly waitSeconds: number;

  constructor(waitSeconds: number) {
    super(`请 ${waitSeconds} 秒后再试`);
    this.name = 'ProbeRateLimitError';
    this.waitSeconds = waitSeconds;
  }
}

/** 同一身份 10 秒内只允许一次探测；超限抛 `ProbeRateLimitError` */
export function assertProbeRateLimit(subject: string): void {
  const now = Date.now();
  const last = lastProbeAt.get(subject) ?? 0;
  if (now - last < PROBE_INTERVAL_MS) {
    throw new ProbeRateLimitError(Math.ceil((PROBE_INTERVAL_MS - (now - last)) / 1000));
  }
  lastProbeAt.set(subject, now);

  // 顺手清理一小时前的记录，避免长期运行累积
  if (lastProbeAt.size > 500) {
    for (const [key, at] of lastProbeAt) {
      if (now - at > 3_600_000) lastProbeAt.delete(key);
    }
  }
}

/** 仅测试用 */
export function resetProbeRateLimit(): void {
  lastProbeAt.clear();
}
