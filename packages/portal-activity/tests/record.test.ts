import { describe, expect, it, vi } from 'vitest';
import { createActivityRecorder, type Db } from '../src/record';

type Call = { text: string; params?: unknown[] };

function collectDb(
  handler?: (text: string, params?: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>
): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db: Db = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      const result = handler ? await handler(text, params) : { rows: [] };
      return { rows: result.rows as never[] };
    },
  };
  return { db, calls };
}

describe('recordLogin', () => {
  it('写入站点、身份与登录方式', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db });

    await recorder.recordLogin({
      sub: 'u-1',
      name: '张伟',
      email: 'z@school.edu',
      method: 'oauth2',
    });

    const insert = calls.find((call) => call.text.includes('INSERT INTO portal_shared.login_events'));
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual(['assign', 'u-1', '张伟', 'z@school.edu', 'oauth2']);
  });

  it('空 sub 不写库', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'member', db: () => db });

    await recorder.recordLogin({ sub: '', method: 'password' });

    expect(calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  });

  it('写库抛错不向外抛', async () => {
    const { db } = collectDb(() => {
      throw new Error('db down');
    });
    const recorder = createActivityRecorder({ site: 'assign', db: () => db, logger: () => {} });

    await expect(recorder.recordLogin({ sub: 'u-1', method: 'cas' })).resolves.toBeUndefined();
  });

  it('数据库未配置时静默', async () => {
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => {
        throw new Error('not configured');
      },
      logger: () => {},
    });

    await expect(recorder.recordLogin({ sub: 'u-1', method: 'wecom' })).resolves.toBeUndefined();
  });

  it('超过写入预算时放弃，不阻塞调用方', async () => {
    const hanging: Db = { query: () => new Promise(() => {}) };
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => hanging,
      timeoutMs: 20,
      logger: () => {},
    });

    const startedAt = Date.now();
    await expect(recorder.recordLogin({ sub: 'u-1', method: 'oauth2' })).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('同类错误在节流窗口内只告警一次', async () => {
    const { db } = collectDb(() => {
      throw new Error('db down');
    });
    const logger = vi.fn();
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      logger,
      pruneIntervalMs: 10_000_000,
    });

    await recorder.recordLogin({ sub: 'u-1', method: 'oauth2' });
    await recorder.recordLogin({ sub: 'u-2', method: 'oauth2' });

    expect(logger).toHaveBeenCalledTimes(1);
  });
});

describe('recordPageView', () => {
  it('规范化路径后写入', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db });

    await recorder.recordPageView('u-1', '/models?range=7d');

    const insert = calls.find((call) => call.text.includes('INSERT INTO portal_shared.page_views'));
    expect(insert?.params).toEqual(['assign', 'u-1', '/models']);
  });

  it('非法路径不写库', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db });

    await recorder.recordPageView('u-1', '//evil.com');
    await recorder.recordPageView('', '/overview');

    expect(calls.some((call) => call.text.includes('INSERT'))).toBe(false);
  });
});

describe('pruneIfDue', () => {
  it('首次触发清理，窗口内不重复', async () => {
    const { db, calls } = collectDb();
    let clock = 1_000;
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      now: () => clock,
      pruneIntervalMs: 1000,
    });

    await recorder.pruneIfDue();
    const firstDeletes = calls.filter((call) => call.text.includes('DELETE')).length;
    expect(firstDeletes).toBeGreaterThan(0);

    clock += 500;
    await recorder.pruneIfDue();
    expect(calls.filter((call) => call.text.includes('DELETE')).length).toBe(firstDeletes);

    clock += 1000;
    await recorder.pruneIfDue();
    expect(calls.filter((call) => call.text.includes('DELETE')).length).toBeGreaterThan(firstDeletes);
  });

  it('满批继续删，未满批停止', async () => {
    let loginDeletes = 0;
    const { db, calls } = collectDb((text) => {
      if (text.includes('DELETE') && text.includes('login_events')) {
        loginDeletes += 1;
        // 第一批返回满批（2 行），第二批返回不足
        return { rows: loginDeletes === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }] };
      }
      return { rows: [] };
    });

    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      pruneBatchSize: 2,
      pruneMaxBatches: 5,
    });

    await recorder.pruneIfDue();

    const loginDeleteCalls = calls.filter(
      (call) => call.text.includes('DELETE') && call.text.includes('login_events')
    );
    expect(loginDeleteCalls.length).toBe(2);
  });

  it('清理抛错不影响后续写入（连续两次登录都落库）', async () => {
    const { db, calls } = collectDb((text) => {
      if (text.includes('DELETE')) throw new Error('lock timeout');
      return { rows: [] };
    });
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      logger: () => {},
      pruneIntervalMs: 0,
    });

    await expect(recorder.recordLogin({ sub: 'u-1', method: 'password' })).resolves.toBeUndefined();
    await expect(recorder.recordLogin({ sub: 'u-2', method: 'password' })).resolves.toBeUndefined();

    // 关键：一次清理失败之后，后续写入仍然照常落库（不是只有第一次成功）
    const inserts = calls.filter((call) =>
      call.text.includes('INSERT INTO portal_shared.login_events')
    );
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.params?.[1]).toBe('u-1');
    expect(inserts[1]?.params?.[1]).toBe('u-2');
  });

  it('满批时最多执行 pruneMaxBatches 批，且每批参数为批量上限', async () => {
    const { db, calls } = collectDb((text) =>
      text.includes('DELETE') ? { rows: [{ id: '1' }, { id: '2' }, { id: '3' }] } : { rows: [] }
    );
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      pruneBatchSize: 3,
      pruneMaxBatches: 2,
      pruneIntervalMs: 0,
    });

    await recorder.pruneIfDue();

    const loginDeletes = calls.filter(
      (call) => call.text.includes('DELETE') && call.text.includes('login_events')
    );
    expect(loginDeletes).toHaveLength(2);
    expect(loginDeletes[0]?.params).toEqual([180, 3]);
  });

  it('默认上限为每表 5 批，避免停摆后一次删空造成长事务', async () => {
    const { db, calls } = collectDb((text) =>
      text.includes('DELETE') ? { rows: [{ id: '1' }] } : { rows: [] }
    );
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      pruneBatchSize: 1,
      pruneIntervalMs: 0,
    });

    await recorder.pruneIfDue();

    for (const table of ['login_events', 'page_views']) {
      const deletes = calls.filter(
        (call) => call.text.includes('DELETE') && call.text.includes(table)
      );
      expect(deletes).toHaveLength(5);
    }
  });
});

describe('功能开关（设置页总开关，缺省关闭）', () => {
  it('关闭时登录与页面访问都不写库，清理也不执行', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      isEnabled: () => false,
      pruneIntervalMs: 0,
    });

    await recorder.recordLogin({ sub: 'u-1', method: 'password' });
    await recorder.recordPageView('u-1', '/overview');
    await recorder.pruneIfDue();

    expect(calls).toHaveLength(0);
  });

  it('开关读取抛错按关闭处理，不把配置错误带进登录流程', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({
      site: 'assign',
      db: () => db,
      isEnabled: () => {
        throw new Error('config store unavailable');
      },
    });

    await expect(recorder.recordLogin({ sub: 'u-1', method: 'password' })).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('开启时照常写入（不改变既有行为）', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db, isEnabled: async () => true });

    await recorder.recordLogin({ sub: 'u-1', method: 'password' });

    expect(calls.some((call) => call.text.includes('INSERT INTO portal_shared.login_events'))).toBe(true);
  });
});
