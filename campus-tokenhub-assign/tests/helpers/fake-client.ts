import type { GatewayClient, GatewayRequest } from '@/lib/gateway/client';

export type GatewayCall = { channel: 'admin' | 'public'; path: string; request?: GatewayRequest };

export type FakeGatewayClient = GatewayClient & {
  calls: GatewayCall[];
};

/** 用回调模拟网关，记录每次调用，便于断言路径/入参。 */
export function fakeClient(
  handler: (call: GatewayCall) => unknown | Promise<unknown>
): FakeGatewayClient {
  const calls: GatewayCall[] = [];

  const run = async (channel: GatewayCall['channel'], path: string, request?: GatewayRequest) => {
    const call: GatewayCall = { channel, path, request };
    calls.push(call);
    const result = await handler(call);
    if (result instanceof Error) throw result;
    return result as never;
  };

  return {
    calls,
    admin: <T,>(path: string, request?: GatewayRequest) => run('admin', path, request) as Promise<T>,
    publicGet: <T,>(path: string) => run('public', path) as Promise<T>,
  };
}

/** 构造带 data 的响应外壳，屏蔽各接口外壳差异 */
export function wrap<T>(data: T, extra: Record<string, unknown> = {}) {
  return { success: true, data, ...extra };
}
