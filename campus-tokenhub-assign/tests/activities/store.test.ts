import { describe, expect, it } from 'vitest';
import { ACTIVITY_CONFIG } from '@/lib/activities/config';
import {
  ActivityConfigError,
  normalizeActivity,
  normalizeActivityList,
  parseActivityConfig,
  readActivityConfig,
  writeActivityConfig,
  type ActivityConfigRepo,
} from '@/lib/activities/store';
import type { TokenActivityConfig } from '@/lib/activities/types';

const sampleActivity = {
  id: 'daily-recharge',
  title: '每日加油包',
  points: 500,
  period: 'daily',
  summary: ['每天一次'],
};

/** 用内存数组模拟「门户表」，验证读写的编排逻辑（SQL 由集成测试覆盖） */
function memoryRepo(
  initial: TokenActivityConfig[] = [],
  options: { initialized?: boolean; fail?: boolean } = {}
): ActivityConfigRepo & { rows: TokenActivityConfig[] } {
  const rows = [...initial];
  return {
    rows,
    async isInitialized() {
      if (options.fail) throw new Error('db down');
      return options.initialized ?? rows.length > 0;
    },
    async list() {
      if (options.fail) throw new Error('db down');
      return [...rows];
    },
    async replaceAll(activities) {
      if (options.fail) throw new Error('db down');
      rows.length = 0;
      rows.push(...activities);
    },
  };
}

describe('readActivityConfig', () => {
  it('表里有数据时以表为准', async () => {
    const repo = memoryRepo([sampleActivity as TokenActivityConfig]);

    const state = await readActivityConfig(repo);

    expect(state).toMatchObject({ managed: true, degraded: false });
    expect(state.activities.map((item) => item.id)).toEqual([sampleActivity.id]);
  });

  it('表为空且未初始化：回退仓库默认配置', async () => {
    const repo = memoryRepo([], { initialized: false });

    const state = await readActivityConfig(repo);

    expect(state.managed).toBe(false);
    expect(state.degraded).toBe(false);
    expect(state.activities.map((item) => item.id)).toEqual(ACTIVITY_CONFIG.map((item) => item.id));
  });

  it('表为空但已初始化：视为管理员清空，不再回退默认值', async () => {
    const repo = memoryRepo([], { initialized: true });

    const state = await readActivityConfig(repo);

    expect(state).toEqual({ activities: [], managed: true, degraded: false });
  });

  it('读数据库失败：回退默认配置并标记降级', async () => {
    const repo = memoryRepo([], { fail: true });

    const state = await readActivityConfig(repo);

    expect(state).toMatchObject({ managed: false, degraded: true });
    expect(state.activities.length).toBeGreaterThan(0);
  });
});

describe('writeActivityConfig', () => {
  it('校验、归一化后整份替换', async () => {
    const repo = memoryRepo([]);

    const saved = await writeActivityConfig(
      [{ ...sampleActivity, title: '  每日加油包  ', summary: ['每天一次', '  '] }],
      repo
    );

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ title: '每日加油包', summary: ['每天一次'] });
    expect(repo.rows).toEqual(saved);
  });

  it('配置非法时不动存储', async () => {
    const repo = memoryRepo([]);

    await expect(writeActivityConfig([{ ...sampleActivity, points: 0 }], repo)).rejects.toBeInstanceOf(
      ActivityConfigError
    );
    expect(repo.rows).toHaveLength(0);
  });
});

describe('normalizeActivity', () => {
  it('丢弃未知字段，只保留配置需要的项', () => {
    const activity = normalizeActivity({ ...sampleActivity, mystery: 'x' });

    expect(activity).not.toHaveProperty('mystery');
    expect(activity).toEqual({
      id: 'daily-recharge',
      title: '每日加油包',
      points: 500,
      period: 'daily',
      summary: ['每天一次'],
    });
  });

  it('活动 ID 只接受小写字母、数字与短横线', () => {
    expect(() => normalizeActivity({ ...sampleActivity, id: 'Daily_Recharge' })).toThrow(
      ActivityConfigError
    );
  });

  it('算力值必须是正整数', () => {
    expect(() => normalizeActivity({ ...sampleActivity, points: 0 })).toThrow(ActivityConfigError);
    expect(() => normalizeActivity({ ...sampleActivity, points: 1.5 })).toThrow(ActivityConfigError);
  });

  it('结束日期不能早于开始日期', () => {
    expect(() =>
      normalizeActivity({ ...sampleActivity, startsOn: '2026-12-31', endsOn: '2026-12-01' })
    ).toThrow(ActivityConfigError);
  });

  it('领取频次只接受四种周期', () => {
    expect(() => normalizeActivity({ ...sampleActivity, period: 'hourly' })).toThrow(
      ActivityConfigError
    );
  });
});

describe('normalizeActivityList', () => {
  it('活动 ID 不允许重复', () => {
    expect(() => normalizeActivityList([sampleActivity, sampleActivity])).toThrow(ActivityConfigError);
  });

  it('超过上限时拒绝', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      ...sampleActivity,
      id: `activity-${index}`,
    }));
    expect(() => normalizeActivityList(many)).toThrow(ActivityConfigError);
  });
});

describe('parseActivityConfig（旧 system_config 值）', () => {
  it('解析旧配置里的 JSON 串', () => {
    expect(parseActivityConfig(JSON.stringify([sampleActivity]))).toHaveLength(1);
  });

  it('不是数组时拒绝', () => {
    expect(() => parseActivityConfig(JSON.stringify({ id: 'x' }))).toThrow(ActivityConfigError);
  });
});
