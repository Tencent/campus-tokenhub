import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 登录落库接线检查（静态断言）。
 *
 * 为什么不用行为测试：callback / password 路由依赖完整的认证栈（config overlay、
 * 适配器、限流、审计），为了验证一条埋点把半套栈 mock 掉，测试会比实现更脆。
 * 这里只锁三个会真实回退的点：接线没被删、站点没写反、重签不计数。
 * `recordLogin` 自身的写入、超时、降级行为由 `packages/portal-activity` 的单测覆盖。
 */

const root = fileURLToPath(new URL('../../src/', import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, 'utf8');

describe('登录事件接线（统一采买站）', () => {
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

  it('站点标识在 recorder 里单点固定为 assign', () => {
    const source = read('lib/activity/recorder.ts');
    expect(source).toContain("site: 'assign'");
    expect(source).not.toContain("site: 'member'");
  });
});
