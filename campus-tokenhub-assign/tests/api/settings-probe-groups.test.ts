import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/portal/settings/probe/route';
import { resetProbeRateLimit } from '@/lib/config/probe-rate-limit';
import { resetConfigCache } from '@/lib/config';
import { clearAdminRoster, stubAdminRoster } from '../helpers/admin-roster';
import { resetOverlayForTests } from '@/lib/config/overlay';
import { resetConfigStoreCache, setConfigRepoOverride } from '@/lib/config/store';
import { resetProbeDeps, setProbeDeps } from '@/lib/config/probe';
import { signSession } from '@/lib/auth/session';
import { membersBaseEnv } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ADMIN_EMAIL = 'admin@school.edu.cn';
const original = { ...process.env };

async function request(body: unknown, sub = '7:17915'): Promise<Request> {
  const token = await signSession({
    sub,
    email: ADMIN_EMAIL,
    name: '管理员',
    octafuseUserId: 'gw-1',
  });
  return new Request('http://portal.test/api/portal/settings/probe', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://portal.test',
      host: 'portal.test',
      cookie: `portal_session=${token}`,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  stubAdminRoster(['7:17915']);
  process.env = { ...original, ...membersBaseEnv };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  // 探测会把结论写进分组验证状态：用内存仓库，避免测试碰真实数据库
  setConfigRepoOverride(memoryConfigRepo().repo);
  resetProbeDeps();
  resetProbeRateLimit();
});

afterEach(() => {
  clearAdminRoster();
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  resetProbeDeps();
  resetProbeRateLimit();
});

describe('探测分组：currency', () => {
  it('读不到币种时按 CNY 处理', async () => {
    setProbeDeps({ currencyProvider: async () => null });
    const response = await POST(await request({ group: 'currency' }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.detail.currency).toBe('CNY');
    expect(body.message).toBeNull();
  });

  it('非 CNY 时给出警告但不失败', async () => {
    setProbeDeps({ currencyProvider: async () => 'USD' });
    const response = await POST(await request({ group: 'currency' }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.detail.warning).toContain('USD');
  });
});

describe('探测分组：admin', () => {
  it('查不到身份返回 unknown，不阻止操作', async () => {
    setProbeDeps({ adminLookup: async () => null });
    const response = await POST(await request({ group: 'admin', draft: { sub: '7:404' } }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.detail.status).toBe('unknown');
  });

  it('缺少 sub 返回 400', async () => {
    const response = await POST(await request({ group: 'admin', draft: {} }));
    expect(response.status).toBe(400);
  });
});

describe('限流与超时', () => {
  it('10 秒内第二次探测返回 429', async () => {
    setProbeDeps({ currencyProvider: async () => 'CNY' });

    const first = await POST(await request({ group: 'currency' }));
    expect(first.status).toBe(200);

    const second = await POST(await request({ group: 'currency' }));
    expect(second.status).toBe(429);
    expect((await second.json()).code).toBe('probe_too_frequent');
  });

  it('上游超时返回 504 与 probe_timeout', async () => {
    setProbeDeps({ currencyProvider: () => new Promise(() => undefined) });

    const response = await POST(await request({ group: 'currency' }));
    expect(response.status).toBe(504);
    expect((await response.json()).code).toBe('probe_timeout');
  }, 20_000);
});
