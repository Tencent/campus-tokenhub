import { describe, expect, it } from 'vitest';
import { createActivityRecorder, type Db } from '../src/record';

/**
 * G2 / G4 边界：开户失败（identity.octafuseUserId 为 null）时用户照样登录成功，
 * 登录事件必须照样落库——统计口径是「谁登录了」，不是「谁开户成功了」。
 *
 * 因此 `recordLogin` 只依赖 `sub`，不允许因为缺少姓名/邮箱或缺少网关用户 ID 就跳过写入。
 */

type Call = { text: string; params?: unknown[] };

function collectDb(): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db: Db = {
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows: [] as never[] };
    },
  };
  return { db, calls };
}

describe('开户失败仍写入登录事件（G2）', () => {
  it('只有 sub 时仍写库，姓名与邮箱落 null', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'member', db: () => db });

    await recorder.recordLogin({ sub: 'sso-user-1', method: 'oauth2' });

    const insert = calls.find((call) => call.text.includes('INSERT INTO portal_shared.login_events'));
    expect(insert).toBeDefined();
    expect(insert?.params).toEqual(['member', 'sso-user-1', null, null, 'oauth2']);
  });

  it('姓名邮箱为空字符串时同样写库，不因空值跳过', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db });

    await recorder.recordLogin({ sub: 'sso-user-2', name: '', email: '', method: 'cas' });

    const insert = calls.find((call) => call.text.includes('INSERT INTO portal_shared.login_events'));
    expect(insert?.params?.[1]).toBe('sso-user-2');
    expect(insert?.params?.[4]).toBe('cas');
  });

  it('插入语句只写统计口径内的列，不夹带网关用户 ID', async () => {
    const { db, calls } = collectDb();
    const recorder = createActivityRecorder({ site: 'assign', db: () => db });

    await recorder.recordLogin({ sub: 'sso-user-3', method: 'wecom' });

    const insert = calls.find((call) => call.text.includes('INSERT INTO portal_shared.login_events'));
    expect(insert?.text).toContain('(site, sub, name, email, login_method)');
    expect(insert?.text).not.toContain('octafuse_user_id');
  });
});
