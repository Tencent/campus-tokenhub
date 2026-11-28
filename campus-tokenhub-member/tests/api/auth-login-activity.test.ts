import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 登录落库接线检查（静态断言，成员站）。
 *
 * 与统一采买站同因：登录路由依赖完整认证栈，行为级 mock 成本远高于收益。
 * 这里只锁接线存在、站点为 member、重签不计数。
 */

const root = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

describe('登录事件接线（成员自购站）', () => {
  it('SSO 回调在签发会话后写入登录事件，并取适配器协议名', () => {
    const source = read('app/api/auth/callback/route.ts');
    expect(source).toContain('activityRecorder.recordLogin');
    expect(source).toContain('method: adapter.kind');
  });

  it('密码登录写入 password 类型', () => {
    const source = read('app/api/auth/password/route.ts');
    expect(source).toContain('activityRecorder.recordLogin');
    expect(source).toContain("method: 'password'");
  });

  it('管理台重签不写登录事件', () => {
    const source = read('app/api/auth/admin-entry/route.ts');
    expect(source).not.toContain('recordLogin');
  });

  it('站点标识在 recorder 里单点固定为 member', () => {
    const source = read('lib/activity/recorder.ts');
    expect(source).toContain("site: 'member'");
    expect(source).not.toContain("site: 'assign'");
  });
});
