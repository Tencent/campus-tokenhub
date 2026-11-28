import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { signSession } from '@/lib/auth/session';

const mocks = vi.hoisted(() => ({ recordPageView: vi.fn() }));

// 开关默认关闭：这里显式打开，让上报链路照常执行；关闭场景单独有用例
const switchMock = vi.hoisted(() => ({ enabled: true }));

vi.mock('@/lib/activity/enabled', () => ({
  isActivityEnabled: async () => switchMock.enabled,
}));

vi.mock('@/lib/activity/recorder', () => ({
  activityRecorder: {
    site: 'member',
    recordLogin: vi.fn(),
    recordPageView: mocks.recordPageView,
    pruneIfDue: vi.fn(),
  },
}));

import { POST } from '@/app/api/portal/activity/visit/route';

const SECRET = 'activity-visit-test-secret-32-chars-ok';
const original = { ...process.env };

beforeEach(() => {
  process.env = {
    ...original,
    OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
    OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
    OCTAFUSE_EXTERNAL_SYSTEM: 'school-sso',
    SESSION_SECRET: SECRET,
  };
  resetConfigCache();
  switchMock.enabled = true;
  mocks.recordPageView.mockReset();
  mocks.recordPageView.mockResolvedValue(undefined);
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
});

async function sessionCookie(): Promise<string> {
  const token = await signSession({
    sub: 'student-1',
    email: 'a@school.edu',
    name: '张三',
  });
  return `portal_session=${token}`;
}

function makeRequest(init: {
  cookie?: string;
  body?: string;
  contentType?: string;
  origin?: string;
}): Request {
  const headers: Record<string, string> = {
    host: 'portal.test',
    origin: init.origin ?? 'http://portal.test',
  };
  if (init.cookie) headers.cookie = init.cookie;
  if (init.contentType) headers['content-type'] = init.contentType;

  return new Request('http://portal.test/api/portal/activity/visit', {
    method: 'POST',
    headers,
    body: init.body,
  });
}

describe('POST /api/portal/activity/visit（成员站）', () => {
  it('未登录返回 401 且不写库', async () => {
    const response = await POST(
      makeRequest({ contentType: 'application/json', body: JSON.stringify({ path: '/members' }) })
    );

    expect(response.status).toBe(401);
    expect(mocks.recordPageView).not.toHaveBeenCalled();
  });

  it('缺少 path 返回 400', async () => {
    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({}),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.recordPageView).not.toHaveBeenCalled();
  });

  it('外站路径返回 400', async () => {
    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({ path: 'https://evil.com' }),
      })
    );

    expect(response.status).toBe(400);
    expect(mocks.recordPageView).not.toHaveBeenCalled();
  });

  it('application/json 合法请求返回 204 并写库一次', async () => {
    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({ path: '/members?p=2' }),
      })
    );

    expect(response.status).toBe(204);
    expect(mocks.recordPageView).toHaveBeenCalledTimes(1);
    expect(mocks.recordPageView).toHaveBeenCalledWith('student-1', '/members');
  });

  it('text/plain 请求体也能解析（sendBeacon 默认形态）', async () => {
    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'text/plain;charset=UTF-8',
        body: JSON.stringify({ path: '/members/review' }),
      })
    );

    expect(response.status).toBe(204);
    expect(mocks.recordPageView).toHaveBeenCalledWith('student-1', '/members/review');
  });

  it('跨站 Origin 被拒绝', async () => {
    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({ path: '/members' }),
        origin: 'http://evil.test',
      })
    );

    expect(response.status).toBe(403);
    expect(mocks.recordPageView).not.toHaveBeenCalled();
  });

  it('写库失败仍返回 204（埋点不能影响页面）', async () => {
    mocks.recordPageView.mockRejectedValue(new Error('db down'));

    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({ path: '/members' }),
      })
    );

    expect(response.status).toBe(204);
  });
});

describe('功能开关关闭时的上报接口', () => {
  it('返回 204 且完全不写库（埋点不能影响页面）', async () => {
    switchMock.enabled = false;

    const response = await POST(
      makeRequest({
        cookie: await sessionCookie(),
        contentType: 'application/json',
        body: JSON.stringify({ path: '/overview' }),
      })
    );

    expect(response.status).toBe(204);
    expect(mocks.recordPageView).not.toHaveBeenCalled();
  });
});
