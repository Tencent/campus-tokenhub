import { describe, expect, it } from 'vitest';
import { GatewayError } from '@/lib/gateway/client';
import {
  createKey,
  getActiveKey,
  getUserLogs,
  hasActiveKey,
  listKeys,
  revokeKey,
} from '@/lib/gateway/keys';
import { fakeClient, wrap } from '../helpers/fake-client';

const rawKey = {
  id: 'key-1',
  key: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
  user_id: 'gw-1',
  name: 'student-1',
  status: 'active',
  metadata: { anything: true },
  rate_limit: null,
  last_used_at: '2026-11-05 11:06:00+00',
  created_at: '2026-11-01 00:00:00+00',
  updated_at: '2026-11-01 00:00:00+00',
};

describe('listKeys', () => {
  it('调 users/:id/keys 并裁剪掉 admin 视角多余字段', async () => {
    const client = fakeClient(() => wrap([rawKey]));

    const keys = await listKeys('gw-1', client);

    expect(client.calls[0].path).toBe('/api/admin/users/gw-1/keys');
    // 列表接口只给掩码：明文不进 SSR / RSC 载荷
    expect(keys[0]).toEqual({
      id: 'key-1',
      key: 'sk-abcdefghi••••••••6789',
      name: 'student-1',
      status: 'active',
      last_used_at: rawKey.last_used_at,
      created_at: rawKey.created_at,
    });
    expect(keys[0]).not.toHaveProperty('metadata');
    expect(keys[0]).not.toHaveProperty('user_id');
  });
});

describe('createKey', () => {
  it('入参只有 user_id 与 name，明文从 data.key 取', async () => {
    const client = fakeClient(() => wrap({ key: 'sk-new', key_id: 'key-2' }));

    const created = await createKey('gw-1', 'student-1', client);

    expect(created).toEqual({ key: 'sk-new', keyId: 'key-2' });
    expect(client.calls[0].request).toMatchObject({
      method: 'POST',
      body: { user_id: 'gw-1', name: 'student-1' },
    });
  });

  it('网关没给明文时报错，不返回半成品', async () => {
    const client = fakeClient(() => wrap({ key_id: 'key-2' }));

    await expect(createKey('gw-1', 'n', client)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('revokeKey', () => {
  it('正常删除', async () => {
    const client = fakeClient(() => wrap(null));

    await expect(revokeKey('key-1', client)).resolves.toEqual({ alreadyGone: false });
    expect(client.calls[0]).toMatchObject({ path: '/api/admin/keys/key-1', request: { method: 'DELETE' } });
  });

  it('404 视为「已经不存在」，算成功', async () => {
    const client = fakeClient(() => new GatewayError('not found', 404));

    await expect(revokeKey('key-1', client)).resolves.toEqual({ alreadyGone: true });
  });

  it('其它错误照常抛出', async () => {
    const client = fakeClient(() => new GatewayError('boom', 500));

    await expect(revokeKey('key-1', client)).rejects.toBeInstanceOf(GatewayError);
  });
});

describe('hasActiveKey / getActiveKey', () => {
  it('getActiveKey 返回明文（只给 /api/portal/key 用）', async () => {
    const client = fakeClient(() => wrap([rawKey]));

    await expect(getActiveKey('gw-1', client)).resolves.toMatchObject({ key: rawKey.key });
  });

  it('识别 status===active', async () => {
    const client = fakeClient(() => wrap([rawKey, { ...rawKey, id: 'key-0', status: 'revoked' }]));

    await expect(hasActiveKey('gw-1', client)).resolves.toBe(true);
    await expect(getActiveKey('gw-1', client)).resolves.toMatchObject({ id: 'key-1' });
  });

  it('没有 active 时报 false / null', async () => {
    const client = fakeClient(() => wrap([{ ...rawKey, status: 'revoked' }]));

    await expect(hasActiveKey('gw-1', client)).resolves.toBe(false);
    await expect(getActiveKey('gw-1', client)).resolves.toBeNull();
  });
});

describe('getUserLogs', () => {
  it('调 users/:id/logs 并带上条数', async () => {
    const client = fakeClient(() =>
      wrap([
        {
          id: 'log-1',
          model_id: 'hy4',
          input_tokens: 22,
          output_tokens: 4,
          total_tokens: 26,
          charged_cost: '0.000092',
          status: 'success',
          latency_ms: 1949,
          created_at: '2026-11-05 11:06:00+00',
        },
      ])
    );

    const logs = await getUserLogs('gw-1', 10, client);

    expect(client.calls[0].path).toBe('/api/admin/users/gw-1/logs');
    expect(logs[0]).toMatchObject({ model_id: 'hy4', total_tokens: 26, charged_cost: '0.000092' });
  });
});
