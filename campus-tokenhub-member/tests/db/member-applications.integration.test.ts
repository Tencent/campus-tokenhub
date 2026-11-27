import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db/portal-db';
import { ensurePortalSchema, resetPortalSchemaCache } from '@/lib/db/portal-schema';
import {
  mutateStore,
  readStore,
  resetApplicationSeedCache,
  setMemberApplicationRepo,
} from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';

const databaseUrl = process.env.PORTAL_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

function sample(id: string): MemberApplication {
  return {
    id,
    applicantSub: '999:999',
    applicantName: '集成测试',
    userId: 999,
    memberName: '集成测试-999',
    email: 'it@school.local',
    countryCode: '86',
    phone: '13800000000',
    departmentPath: '教务处',
    resolvedNodeId: null,
    resolvedNodePath: null,
    remark: '',
    status: 'pending',
    uin: null,
    errorCode: null,
    errorMessage: null,
    tencentRequestId: null,
    reviewNote: null,
    reviewedBy: null,
    reviewedAt: null,
    provisioningStartedAt: null,
    removingStartedAt: null,
    deletedAt: null,
    deleteRequestId: null,
    deleteError: null,
    lastAttemptAt: null,
    revision: 0,
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

suite('成员申请单表（真实 Postgres）', () => {
  beforeEach(async () => {
    process.env.PORTAL_DATABASE_URL = databaseUrl;
    setMemberApplicationRepo(null);
    resetPortalSchemaCache();
    resetApplicationSeedCache();
    await ensurePortalSchema();
  });

  afterAll(async () => {
    await closeDb();
  });

  it('建表、写入、读回、删除（事件 JSONB 与 NULL 字段都能往返）', async () => {
    const id = `it-${Date.now()}`;

    await mutateStore((apps) => {
      apps.push(sample(id));
    });

    const created = (await readStore()).find((app) => app.id === id);
    expect(created).toMatchObject({
      id,
      status: 'pending',
      departmentPath: '教务处',
      resolvedNodeId: null,
      resolvedNodePath: null,
      events: [],
    });

    await mutateStore((apps) => {
      const target = apps.find((app) => app.id === id);
      if (target) {
        target.status = 'failed';
        target.events = [{ at: new Date().toISOString(), from: 'pending', to: 'failed', actor: 'admin' }];
      }
    });

    const updated = (await readStore()).find((app) => app.id === id);
    expect(updated?.status).toBe('failed');
    expect(updated?.events).toHaveLength(1);

    await mutateStore((apps) => {
      const index = apps.findIndex((app) => app.id === id);
      if (index >= 0) apps.splice(index, 1);
    });

    expect((await readStore()).some((app) => app.id === id)).toBe(false);
  });
});
