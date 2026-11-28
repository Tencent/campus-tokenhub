/**
 * 页面访问上报的传输层（纯函数，便于单测）。
 *
 * `sendBeacon` 直接传字符串会以 `text/plain` 发出，服务端 `request.json()` 会 415；
 * 必须包成 `Blob` 显式声明 JSON。beacon 不可用时降级 `fetch keepalive`，
 * 两种都失败就静默——埋点不能影响页面。
 */

export type VisitTransport = {
  sendBeacon?: (url: string, data: Blob) => boolean;
  fetch?: (input: string, init: RequestInit) => Promise<unknown>;
};

export type VisitReportResult = 'beacon' | 'fetch' | 'skipped';

/** 上报路径；返回实际使用的通道，便于调用方在测试里断言 */
export function reportVisit(
  endpoint: string,
  path: string,
  transport: VisitTransport
): VisitReportResult {
  if (!path.startsWith('/') || !endpoint) return 'skipped';

  const body = JSON.stringify({ path });

  if (transport.sendBeacon) {
    try {
      const blob = new Blob([body], { type: 'application/json' });
      if (transport.sendBeacon(endpoint, blob)) return 'beacon';
    } catch {
      // 落到 fetch 分支
    }
  }

  if (transport.fetch) {
    try {
      void transport.fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: true,
        credentials: 'same-origin',
      });
      return 'fetch';
    } catch {
      // 静默
    }
  }

  return 'skipped';
}
