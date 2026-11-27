import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * `scripts/bootstrap-admin.mjs` 的兜底路径。
 *
 * 只覆盖「不会碰数据库」的分支：参数与配置校验。真正的写入是幂等的
 * `INSERT ... ON CONFLICT DO NOTHING`，由真实部署验证（本轮已在旧库上实跑过）。
 * 放在单测里是因为这些分支最容易写错，而且出问题时恰恰是"连不上库、又没有管理员"的时刻。
 */
function run(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync('node', ['scripts/bootstrap-admin.mjs', ...args], {
    cwd: process.cwd(),
    // 刻意不继承 process.env：避免宿主机上的 PORTAL_DATABASE_URL 混进用例
    env: { PATH: process.env.PATH ?? '', ...env } as unknown as NodeJS.ProcessEnv,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('bootstrap-admin', () => {
  it('缺少参数时报格式错误并退出 1', () => {
    const { status, stderr } = run([]);

    expect(status).toBe(1);
    expect(stderr).toContain('school_id:user_id');
  });

  it('身份格式不合法（没有冒号）时拒绝执行', () => {
    const { status, stderr } = run(['100051']);

    expect(status).toBe(1);
    expect(stderr).toContain('school_id:user_id');
  });

  it('身份里带逗号（会被当成两个身份）时拒绝执行', () => {
    const { status, stderr } = run(['a:1,b:2']);

    expect(status).toBe(1);
    expect(stderr).toContain('school_id:user_id');
  });

  it('没有数据库连接串时直接失败，不会静默跳过', () => {
    const { status, stderr } = run(['school_001:100234567']);

    expect(status).toBe(1);
    expect(stderr).toContain('PORTAL_DATABASE_URL');
  });

  it('连接串不可达时给出可读错误，不抛未捕获异常', () => {
    const { status, stderr } = run(['school_001:100234567'], {
      // 故意指向一个不监听的端口
      PORTAL_DATABASE_URL: 'postgres://u:p@127.0.0.1:1/none',
    });

    expect(status).toBe(1);
    expect(stderr).toContain('执行失败');
    // 不能把堆栈糊在用户脸上
    expect(stderr).not.toContain('at Object.<anonymous>');
  });
});
