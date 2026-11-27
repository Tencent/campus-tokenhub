import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ query: vi.fn(), configured: true }));

vi.mock('@/lib/db/portal-db', () => ({
  isPortalDbConfigured: () => db.configured,
  getDb: () => ({ query: db.query }),
}));

import {
  isSessionRevoked,
  readSessionRevokedBefore,
  resetSessionRevocationCache,
  revokeSessionsFor,
} from '@/lib/auth/revocation';

beforeEach(() => {
  db.query.mockReset();
  db.configured = true;
  resetSessionRevocationCache();
});

describe('readSessionRevokedBefore', () => {
  it('没有数据库时直接返回 null（不抛错）', async () => {
    db.configured = false;
    await expect(readSessionRevokedBefore('7:1')).resolves.toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('查不到记录返回 null', async () => {
    db.query.mockResolvedValue({ rows: [] });
    await expect(readSessionRevokedBefore('7:1')).resolves.toBeNull();
  });

  it('返回吊销时间点，并按 sub 缓存 60 秒', async () => {
    db.query.mockResolvedValue({ rows: [{ revokedBefore: '2026-11-20T00:00:00.000Z' }] });

    const first = await readSessionRevokedBefore('7:1');
    const second = await readSessionRevokedBefore('7:1');

    expect(first).toBe(Date.parse('2026-11-20T00:00:00.000Z'));
    expect(second).toBe(first);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('数据库异常时按未吊销处理，不把全校挡在门外', async () => {
    db.query.mockRejectedValue(new Error('db down'));
    await expect(readSessionRevokedBefore('7:1')).resolves.toBeNull();
  });

  it('失败结果只缓存 5 秒：故障期间不重复查库', async () => {
    db.query.mockRejectedValue(new Error('db down'));

    await expect(readSessionRevokedBefore('7:1')).resolves.toBeNull();
    await expect(readSessionRevokedBefore('7:1')).resolves.toBeNull();

    // 第二次命中失败缓存，不再打库：否则每个请求一次失败查询，会把连接池吃满
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('isSessionRevoked', () => {
  it('签发早于吊销时间点的会话失效', async () => {
    const revokedAt = Date.parse('2026-11-20T10:00:00Z');
    db.query.mockResolvedValue({ rows: [{ revokedBefore: new Date(revokedAt).toISOString() }] });

    await expect(isSessionRevoked({ sub: '7:1', iat: revokedAt / 1000 - 60 })).resolves.toBe(true);
    await expect(isSessionRevoked({ sub: '7:1', iat: revokedAt / 1000 + 60 })).resolves.toBe(false);
  });
});

describe('revokeSessionsFor', () => {
  it('写库并立即在进程内生效', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const at = Date.parse('2026-11-20T10:00:00Z');

    await revokeSessionsFor('7:1', at);

    expect(db.query).toHaveBeenCalledTimes(1);
    await expect(readSessionRevokedBefore('7:1')).resolves.toBe(at);
    // 缓存已生效，不会再查一次库
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
