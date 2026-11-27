import { describe, expect, it, vi } from 'vitest';
import { refreshAfterMutation } from '@/lib/portal/refresh-after-mutation';

describe('写成功后的缓存与列表更新', () => {
  it('先失效路由缓存，再重新读取列表', async () => {
    const order: string[] = [];
    const result = await refreshAfterMutation(
      () => { order.push('invalidate'); },
      async () => { order.push('read'); }
    );
    expect(order).toEqual(['invalidate', 'read']);
    expect(result).toEqual({ refreshed: true });
  });

  it('读取失败仍执行失效，并单独返回读取错误', async () => {
    const invalidate = vi.fn();
    const result = await refreshAfterMutation(invalidate, async () => { throw new Error('网络中断'); });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(result).toEqual({ refreshed: false, error: '网络中断' });
  });

  it('非 Error 读取失败也保留失效并返回安全提示', async () => {
    const invalidate = vi.fn();
    const result = await refreshAfterMutation(invalidate, async () => { throw null; });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(result).toEqual({ refreshed: false, error: '读取密钥失败' });
  });
});
