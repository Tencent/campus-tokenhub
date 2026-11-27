import { describe, expect, it } from 'vitest';
import {
  nameFromGatewayEmail,
  readAdminCandidates,
  readGatewayDisplayNames,
} from '@/lib/admin/candidates';
import type { AdminRosterRepo } from '@/lib/admin/roster';
import type { Db } from '@/lib/db/portal-db';

/** 内存名单：候选只关心 subs，写操作不需要实现 */
function memoryRepo(subs: string[]): AdminRosterRepo {
  return {
    async list() {
      return [...subs];
    },
    async replaceAll() {},
    async add() {},
    async remove() {},
  };
}

/** 只实现 query 的假数据库，用来断言网关表查询与解析 */
function fakeDb(rows: { sub: string; email: string | null }[]): Db {
  return { query: async () => ({ rows }) } as unknown as Db;
}

describe('管理员候选（成员站）', () => {
  const applications = async () => [
    { applicantSub: '100051:1001', applicantName: '张三', email: 'zhangsan@school.edu.cn' },
    { applicantSub: '100051:1002', applicantName: '李四', email: null },
    { applicantSub: '100051:1003', applicantName: '王五', email: null },
  ];

  it('未输入关键字时带上名单项，并用申请记录补姓名', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      applications,
      userDirectory: async () => [],
      repo: memoryRepo(['100051:1001', '100051:1002']),
    });

    expect(candidates.map((item) => item.sub).sort()).toEqual(['100051:1001', '100051:1002']);
    expect(candidates.every((item) => item.listed)).toBe(true);
    expect(candidates.find((item) => item.sub === '100051:1002')?.name).toBe('李四');
  });

  it('搜索时只返回命中的申请记录，不再用名单项占满候选', async () => {
    let directoryCalls = 0;
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      query: '王',
      applications,
      userDirectory: async () => {
        directoryCalls += 1;
        return [];
      },
      repo: memoryRepo(['100051:1001', '100051:1002']),
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sub: '100051:1003', name: '王五', listed: false });
    expect(directoryCalls).toBe(0);
  });

  it('搜索无结果时返回空数组，让弹窗显示空态', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      query: '不存在的账号',
      applications,
      userDirectory: async () => [],
      repo: memoryRepo(['100051:1001', '100051:1002']),
    });

    expect(candidates).toEqual([]);
  });

  it('存量管理员没有申请单时，由网关用户表补出姓名', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      applications: async () => [],
      userDirectory: async () => [
        {
          sub: '100051:1002',
          name: '贠泽文',
          email: '贠泽文.100051-1002@school.local',
        },
      ],
      repo: memoryRepo(['100051:1001', '100051:1002']),
    });

    expect(candidates.find((item) => item.sub === '100051:1002')?.name).toBe('贠泽文');
    expect(candidates.find((item) => item.sub === '100051:1001')?.name).toBe('100051:1001');
  });

  it('网关姓名优先级高于申请记录姓名', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1001',
      applications,
      userDirectory: async () => [
        { sub: '100051:1002', name: '网关姓名', email: '网关.100051-1002@school.local' },
      ],
      repo: memoryRepo(['100051:1002']),
    });

    expect(candidates.find((item) => item.sub === '100051:1002')?.name).toBe('网关姓名');
  });

  it('姓名来源抛错时降级，名单仍可展示', async () => {
    const candidates = await readAdminCandidates({
      currentSub: '100051:1002',
      applications,
      userDirectory: async () => {
        throw new Error('gateway unavailable');
      },
      repo: memoryRepo(['100051:1002']),
    });

    expect(candidates.map((item) => item.sub)).toEqual(['100051:1002']);
    expect(candidates[0]?.name).toBe('李四');
  });
});

describe('网关用户姓名解析', () => {
  it('从开户兜底邮箱里取出姓名，真实邮箱返回空串', () => {
    expect(nameFromGatewayEmail('刘海龙.100051-1013041@school.local')).toBe('刘海龙');
    expect(nameFromGatewayEmail('100051-1013041@school.local')).toBe('');
    expect(nameFromGatewayEmail('zhangsan@school.edu.cn')).toBe('');
    expect(nameFromGatewayEmail(null)).toBe('');
  });

  it('按 sub 批量查网关表，跳过解析不出姓名的邮箱', async () => {
    const names = await readGatewayDisplayNames(
      ['100051:1002', '100051:1003'],
      fakeDb([
        { sub: '100051:1002', email: '李四.100051-1002@school.local' },
        { sub: '100051:1003', email: 'wang@school.edu.cn' },
      ])
    );

    expect(names).toEqual([
      { sub: '100051:1002', name: '李四', email: '李四.100051-1002@school.local' },
    ]);
  });

  it('网关表不存在（单站部署）时降级为空', async () => {
    const db = {
      query: async () => {
        throw new Error('relation "octafuse_gateway.users" does not exist');
      },
    } as unknown as Db;

    expect(await readGatewayDisplayNames(['100051:1002'], db)).toEqual([]);
  });

  it('空名单不发查询', async () => {
    let called = false;
    const db = {
      query: async () => {
        called = true;
        return { rows: [] };
      },
    } as unknown as Db;

    expect(await readGatewayDisplayNames([], db)).toEqual([]);
    expect(called).toBe(false);
  });
});
