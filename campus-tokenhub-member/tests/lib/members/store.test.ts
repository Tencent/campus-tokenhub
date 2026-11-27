import { afterEach, describe, expect, it } from 'vitest';
import {
  MemberStoreError,
  mutateStore,
  parseLegacyFile,
  readStore,
  setMemberApplicationRepo,
} from '@/lib/members/store';
import type { MemberApplication } from '@/lib/members/types';
import { createMemoryApplicationRepo } from '../../helpers/members';

function makeApp(overrides: Partial<MemberApplication> = {}): MemberApplication {
  return {
    id: 'app-1',
    applicantSub: '7:17915',
    applicantName: '张三',
    userId: 17915,
    memberName: '张三-17915',
    email: 'zhangsan@school.edu',
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
    createdAt: '2026-11-18T10:00:00.000Z',
    updatedAt: '2026-11-18T10:00:00.000Z',
    ...overrides,
  };
}

afterEach(() => {
  setMemberApplicationRepo(null);
});

describe('成员申请单存储（读全量 → 改 → 写回）', () => {
  it('空存储返回空列表', async () => {
    setMemberApplicationRepo(createMemoryApplicationRepo());

    await expect(readStore()).resolves.toEqual([]);
  });

  it('mutate 写入后能读回，返回值透传', async () => {
    setMemberApplicationRepo(createMemoryApplicationRepo());

    const returned = await mutateStore((apps) => {
      apps.push(makeApp());
      return apps.length;
    });

    expect(returned).toBe(1);
    await expect(readStore()).resolves.toMatchObject([{ id: 'app-1', status: 'pending' }]);
  });

  it('并发更新不同申请单，记录数与字段都正确', async () => {
    setMemberApplicationRepo(createMemoryApplicationRepo());

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        mutateStore((apps) => {
          apps.push(
            makeApp({
              id: `app-${index}`,
              applicantSub: `7:${1000 + index}`,
              userId: 1000 + index,
              memberName: `教师-${1000 + index}`,
            })
          );
        })
      )
    );

    const apps = await readStore();
    expect(apps).toHaveLength(20);
    expect(new Set(apps.map((app) => app.id)).size).toBe(20);
  });

  it('mutator 抛错时不写入任何改动', async () => {
    setMemberApplicationRepo(createMemoryApplicationRepo([makeApp()]));

    await expect(
      mutateStore((apps) => {
        apps.push(makeApp({ id: 'app-2' }));
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    await expect(readStore()).resolves.toHaveLength(1);
  });

  it('events 超过 20 条只保留最新 20 条', async () => {
    const events = Array.from({ length: 25 }, (_, index) => ({
      at: `2026-11-18T10:00:${String(index).padStart(2, '0')}.000Z`,
      from: 'pending' as const,
      to: 'pending' as const,
      actor: 'user' as const,
      note: `#${index}`,
    }));

    setMemberApplicationRepo(createMemoryApplicationRepo([makeApp({ events })]));

    // 写回时才裁剪，读的是内存里的原始记录，这里借一次 mutate 触发写回
    await mutateStore((apps) => {
      apps[0].updatedAt = '2026-11-18T11:00:00.000Z';
    });

    const apps = await readStore();
    expect(apps[0].events).toHaveLength(20);
    expect(apps[0].events[0].note).toBe('#5');
    expect(apps[0].events.at(-1)?.note).toBe('#24');
  });
});

describe('旧 JSON 文件解析（迁移用）', () => {
  it('缺 departmentPath / resolvedNode* 的旧记录兜底为空值', () => {
    const legacy = {
      version: 1,
      applications: [
        {
          id: 'app-legacy',
          applicantSub: '7:1001',
          applicantName: '张三',
          userId: 1001,
          memberName: '张三-1001',
          email: 'a@school.edu',
          countryCode: '86',
          phone: '13800000000',
          remark: '',
          status: 'pending',
          events: [],
          createdAt: '2026-11-18T10:00:00.000Z',
          updatedAt: '2026-11-18T10:00:00.000Z',
        },
      ],
    };

    const apps = parseLegacyFile(JSON.stringify(legacy));

    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      id: 'app-legacy',
      departmentPath: '',
      resolvedNodeId: null,
      resolvedNodePath: null,
      status: 'pending',
    });
  });

  it('不是合法 JSON 时抛 MemberStoreError', () => {
    expect(() => parseLegacyFile('{ broken json')).toThrow(MemberStoreError);
  });

  it('缺少 applications 数组时抛 MemberStoreError', () => {
    expect(() => parseLegacyFile(JSON.stringify({ version: 1 }))).toThrow(MemberStoreError);
  });

  it('缺少 id / applicantSub 的脏记录直接跳过', () => {
    const apps = parseLegacyFile(
      JSON.stringify({ version: 1, applications: [{ id: '' }, { id: 'x' }, null] })
    );
    expect(apps).toEqual([]);
  });
});
