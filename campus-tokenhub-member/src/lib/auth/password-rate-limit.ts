/**
 * 引导期账号密码登录的失败限流（进程内）。
 *
 * 这一层的目标只有一个：让「共享口令」在被爆破时先慢下来。
 * 因此刻意做得极简——按客户端 IP 计数，15 分钟窗口内失败 5 次即锁定，
 * 成功登录清零；多副本各自计数，真正的兜底建议放在反向代理按 IP 限流。
 *
 * 独立成模块（而不是塞进 route）：route 只能导出 HTTP 方法，限流状态与测试用
 * 重置函数放在这里，测试可以直接操作，语义也更容易被单测覆盖。
 */

/** 统计窗口：15 分钟 */
export const PASSWORD_LOGIN_WINDOW_MS = 15 * 60_000;
/** 窗口内允许的失败次数，达到即锁定 */
export const PASSWORD_LOGIN_MAX_FAILURES = 5;
/** 超过这个规模就顺手清一次过期记录，避免长期运行累积 */
const CLEANUP_THRESHOLD = 500;

type Attempt = { failures: number; resetAt: number };

const attempts = new Map<string, Attempt>();

export class PasswordRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`尝试过于频繁，请 ${Math.max(retryAfterSeconds, 1)} 秒后再试`);
    this.name = 'PasswordRateLimitError';
    this.retryAfterSeconds = Math.max(retryAfterSeconds, 1);
  }
}

function liveEntry(ip: string, now: number): Attempt | null {
  const entry = attempts.get(ip);
  if (!entry) return null;
  if (now >= entry.resetAt) {
    // 窗口结束：清掉，下一次失败从 1 开始
    attempts.delete(ip);
    return null;
  }
  return entry;
}

/** 超限抛 `PasswordRateLimitError`；未超限静默返回 */
export function assertPasswordLoginAllowed(ip: string, now = Date.now()): void {
  const entry = liveEntry(ip, now);
  if (!entry || entry.failures < PASSWORD_LOGIN_MAX_FAILURES) return;
  throw new PasswordRateLimitError(Math.ceil((entry.resetAt - now) / 1000));
}

/** 记一次失败；窗口从第一次失败开始计时，不随每次失败顺延（避免被无限拖长） */
export function recordPasswordLoginFailure(ip: string, now = Date.now()): void {
  const entry = liveEntry(ip, now);
  if (entry) {
    entry.failures += 1;
  } else {
    attempts.set(ip, { failures: 1, resetAt: now + PASSWORD_LOGIN_WINDOW_MS });
  }

  if (attempts.size > CLEANUP_THRESHOLD) {
    for (const [key, value] of attempts) {
      if (now >= value.resetAt) attempts.delete(key);
    }
  }
}

/** 登录成功：该 IP 的失败计数清零 */
export function resetPasswordLoginFailures(ip: string): void {
  attempts.delete(ip);
}

/** 仅测试用 */
export function resetPasswordRateLimit(): void {
  attempts.clear();
}
