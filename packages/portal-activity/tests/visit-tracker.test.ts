import { describe, expect, it, vi } from 'vitest';
import { reportVisit, type VisitTransport } from '../src/transport';

describe('reportVisit', () => {
  it('优先用 beacon，且声明 application/json', () => {
    let received: Blob | undefined;
    const transport: VisitTransport = {
      sendBeacon: (_url, data) => {
        received = data;
        return true;
      },
    };

    const result = reportVisit('/api/portal/activity/visit', '/overview', transport);

    expect(result).toBe('beacon');
    expect(received?.type).toBe('application/json');
  });

  it('beacon 返回 false 时降级 fetch', () => {
    const fetchSpy = vi.fn(async () => undefined);
    const transport: VisitTransport = {
      sendBeacon: () => false,
      fetch: fetchSpy,
    };

    const result = reportVisit('/api/portal/activity/visit', '/models', transport);

    expect(result).toBe('fetch');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('beacon 抛错时降级 fetch', () => {
    const fetchSpy = vi.fn(async () => undefined);
    const transport: VisitTransport = {
      sendBeacon: () => {
        throw new Error('beacon blocked');
      },
      fetch: fetchSpy,
    };

    expect(reportVisit('/api/portal/activity/visit', '/models', transport)).toBe('fetch');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('fetch 携带 keepalive 与同源凭据', () => {
    const fetchSpy = vi.fn(async (_input: string, _init: RequestInit) => undefined);
    reportVisit('/api/portal/activity/visit', '/dashboard', { fetch: fetchSpy });

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('same-origin');
    expect(init.body).toBe(JSON.stringify({ path: '/dashboard' }));
  });

  it('两种通道都没有时跳过', () => {
    expect(reportVisit('/api/portal/activity/visit', '/overview', {})).toBe('skipped');
  });

  it('非法路径不上报', () => {
    const sendBeacon = vi.fn(() => true);
    expect(reportVisit('/api/portal/activity/visit', 'evil.com', { sendBeacon })).toBe('skipped');
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it('空 endpoint 不上报', () => {
    const sendBeacon = vi.fn(() => true);
    expect(reportVisit('', '/overview', { sendBeacon })).toBe('skipped');
    expect(sendBeacon).not.toHaveBeenCalled();
  });
});
