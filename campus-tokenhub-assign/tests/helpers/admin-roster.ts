import { resetAdminRosterCache, setAdminRosterRepoOverride } from '@/lib/admin/roster';

/**
 * 注入内存版管理员名单。
 *
 * 管理员判定已改为「数据库名单 / 引导账号 / 名单为空时的初始化 owner」，
 * 测试不能再靠环境变量白名单让别人变成管理员，只能显式给出名单内容。
 */
export function stubAdminRoster(subs: string[]): void {
  // 用可变副本：首登认领会往里写，后续断言要能读到认领结果
  const state = [...subs];
  setAdminRosterRepoOverride({
    list: async () => [...state],
    replaceAll: async (next) => {
      state.length = 0;
      state.push(...next);
    },
    add: async (entries) => {
      for (const entry of entries) if (!state.includes(entry)) state.push(entry);
    },
    remove: async (entry) => {
      const index = state.indexOf(entry);
      if (index >= 0) state.splice(index, 1);
    },
  });
  resetAdminRosterCache();
}

export function clearAdminRoster(): void {
  setAdminRosterRepoOverride(null);
  resetAdminRosterCache();
}
