import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LastAdminError,
  addAdmins,
  claimFirstAdmin,
  isValidAdminSub,
  parseAdminSubs,
  readAdminSubs,
  removeAdmin,
  resetAdminClaimCacheForTests,
  setAdminRosterRepoOverride,
  writeAdminSubs,
  type AdminRosterRepo,
} from '@/lib/admin/roster';

/** 内存实现：仓库层可整体替换，测试不碰真实数据库 */
function memoryRepo(seed: string[] = []): AdminRosterRepo {
  let subs = [...seed];
  return {
    async list() {
      return [...subs];
    },
    async replaceAll(next) {
      subs = [...next];
    },
    async add(entries) {
      for (const entry of entries) if (!subs.includes(entry)) subs.push(entry);
    },
    async remove(sub) {
      subs = subs.filter((item) => item !== sub);
    },
  };
}

afterEach(() => {
  setAdminRosterRepoOverride(null);
  resetAdminClaimCacheForTests();
});

describe('管理员名单（共享表 portal_shared.admins，member 侧）', () => {
  it('readAdminSubs 从注入的仓库读取', async () => {
    setAdminRosterRepoOverride(memoryRepo(['school_001:1001', 'school_001:1002']));

    const result = await readAdminSubs();

    expect(result.subs).toEqual(['school_001:1001', 'school_001:1002']);
    expect(result.managed).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('仓库异常时降级为空名单而不是抛错', async () => {
    setAdminRosterRepoOverride({
      async list() {
        throw new Error('db down');
      },
      async replaceAll() {},
      async add() {},
      async remove() {},
    });

    const result = await readAdminSubs();

    expect(result).toEqual({ subs: [], managed: false, degraded: true });
  });

  it('writeAdminSubs 拆分、去重、丢掉没有冒号的脏项', async () => {
    setAdminRosterRepoOverride(memoryRepo());

    const saved = await writeAdminSubs(['school_001:1', 'bad-entry', 'school_001:1', ' school_001:2 ']);

    expect(saved).toEqual(['school_001:1', 'school_001:2']);
  });

  it('addAdmins 拒绝格式非法的身份', async () => {
    setAdminRosterRepoOverride(memoryRepo());

    await expect(addAdmins(['no-colon'])).rejects.toThrow('school_id:user_id');
  });

  it('addAdmins 只写缺的那些，重复添加不产生重复行', async () => {
    setAdminRosterRepoOverride(memoryRepo(['school_001:1']));

    await addAdmins(['school_001:1', 'school_001:2']);
    const result = await readAdminSubs();

    expect(result.subs).toEqual(['school_001:1', 'school_001:2']);
  });

  it('removeAdmin 删除最后一名管理员时抛 LastAdminError', async () => {
    setAdminRosterRepoOverride(memoryRepo(['school_001:1']));

    await expect(removeAdmin('school_001:1')).rejects.toBeInstanceOf(LastAdminError);
  });

  it('removeAdmin 有多名时正常删除', async () => {
    setAdminRosterRepoOverride(memoryRepo(['school_001:1', 'school_001:2']));

    const left = await removeAdmin('school_001:1');

    expect(left).toEqual(['school_001:2']);
  });

  it('parseAdminSubs 与 isValidAdminSub 口径一致', () => {
    expect(parseAdminSubs('a:1, b:2 ,bad, a:1')).toEqual(['a:1', 'b:2']);
    expect(isValidAdminSub('school_001:1001')).toBe(true);
    expect(isValidAdminSub('zhangsan@school.edu.cn')).toBe(false);
    expect(isValidAdminSub('a b:c')).toBe(false);
  });

  it('引导账号 local:ops-admin 不是合法管理员身份，也不被名单读取/批量写入', async () => {
    expect(isValidAdminSub('local:ops-admin')).toBe(false);
    expect(parseAdminSubs('local:ops-admin,school_001:1001')).toEqual(['school_001:1001']);
    setAdminRosterRepoOverride(memoryRepo(['local:ops-admin']));
    expect((await readAdminSubs()).subs).toEqual([]);
  });

  it('名单里只有历史脏数据 local:ops-admin 时，首个 SSO 用户仍能认领', async () => {
    setAdminRosterRepoOverride(memoryRepo(['local:ops-admin']));
    resetAdminClaimCacheForTests();

    expect(await claimFirstAdmin('100051:1012173')).toBe(true);
    expect((await readAdminSubs()).subs).toEqual(['100051:1012173']);
  });

  it('名单已有真实管理员时首登认领仍被拒绝', async () => {
    setAdminRosterRepoOverride(memoryRepo(['local:ops-admin', '100051:1001']));
    resetAdminClaimCacheForTests();

    expect(await claimFirstAdmin('100051:1012173')).toBe(false);
  });
});

describe('管理员名单页面路径', () => {
  const root = process.cwd();

  it('member 侧入口是 /admins', () => {
    expect(existsSync(join(root, 'src/app/(portal)/admins/page.tsx'))).toBe(true);
  });

  it('member 侧不再有 /members/admins', () => {
    expect(existsSync(join(root, 'src/app/(portal)/members/admins'))).toBe(false);
  });
});
