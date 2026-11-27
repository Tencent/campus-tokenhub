import { beforeEach, describe, expect, it } from 'vitest';
import {
  PASSWORD_LOGIN_MAX_FAILURES,
  PASSWORD_LOGIN_WINDOW_MS,
  PasswordRateLimitError,
  assertPasswordLoginAllowed,
  recordPasswordLoginFailure,
  resetPasswordLoginFailures,
  resetPasswordRateLimit,
} from '@/lib/auth/password-rate-limit';

const T0 = Date.UTC(2026, 10, 23, 3, 0, 0);

beforeEach(() => {
  resetPasswordRateLimit();
});

describe('密码登录限流', () => {
  it('窗口内失败未达上限时放行', () => {
    for (let i = 0; i < PASSWORD_LOGIN_MAX_FAILURES - 1; i += 1) {
      recordPasswordLoginFailure('1.1.1.1', T0 + i);
      expect(() => assertPasswordLoginAllowed('1.1.1.1', T0 + i)).not.toThrow();
    }
  });

  it('达到上限后锁定，并给出剩余秒数', () => {
    for (let i = 0; i < PASSWORD_LOGIN_MAX_FAILURES; i += 1) {
      recordPasswordLoginFailure('1.1.1.1', T0);
    }

    expect(() => assertPasswordLoginAllowed('1.1.1.1', T0 + 1000)).toThrow(PasswordRateLimitError);
    try {
      assertPasswordLoginAllowed('1.1.1.1', T0 + 1000);
    } catch (error) {
      expect((error as PasswordRateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    }
  });

  it('窗口过期后恢复', () => {
    for (let i = 0; i < PASSWORD_LOGIN_MAX_FAILURES; i += 1) {
      recordPasswordLoginFailure('1.1.1.1', T0);
    }
    expect(() => assertPasswordLoginAllowed('1.1.1.1', T0 + PASSWORD_LOGIN_WINDOW_MS + 1)).not.toThrow();
  });

  it('成功登录清零后重新计数', () => {
    for (let i = 0; i < PASSWORD_LOGIN_MAX_FAILURES; i += 1) {
      recordPasswordLoginFailure('1.1.1.1', T0);
    }
    resetPasswordLoginFailures('1.1.1.1');

    expect(() => assertPasswordLoginAllowed('1.1.1.1', T0 + 1000)).not.toThrow();
    recordPasswordLoginFailure('1.1.1.1', T0 + 1000);
    expect(() => assertPasswordLoginAllowed('1.1.1.1', T0 + 1000)).not.toThrow();
  });

  it('按 IP 独立计数，不互相牵连', () => {
    for (let i = 0; i < PASSWORD_LOGIN_MAX_FAILURES; i += 1) {
      recordPasswordLoginFailure('1.1.1.1', T0);
    }

    expect(() => assertPasswordLoginAllowed('2.2.2.2', T0)).not.toThrow();
  });

  it('空 IP 也不会抛异常（取不到客户端地址时按同一桶计数）', () => {
    expect(() => assertPasswordLoginAllowed('', T0)).not.toThrow();
    recordPasswordLoginFailure('', T0);
    expect(() => assertPasswordLoginAllowed('', T0)).not.toThrow();
  });
});
