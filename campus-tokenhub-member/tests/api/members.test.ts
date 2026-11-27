import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDataDir, memberRequest, resetMembersEnv } from '../helpers/members';
import { readStore } from '@/lib/members/store';

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));

vi.mock('@/lib/audit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/audit')>();
  return { ...actual, audit: mocks.audit };
});

import { GET, POST } from '@/app/api/portal/members/route';

const validBody = {
  email: 'zhangsan@school.edu',
  countryCode: '86',
  phone: '13800000000',
  departmentPath: '教务处/数学组',
  remark: '教务处',
};

let dataDir = '';

beforeEach(async () => {
  dataDir = await makeDataDir();
  resetMembersEnv({ PORTAL_DATA_DIR: dataDir });
  vi.clearAllMocks();
});

describe('POST /api/portal/members', () => {
  it('首次提交创建 pending 申请单，并写审计', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', { body: validBody })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { application: { status: string; memberName: string } };
    expect(body.application.status).toBe('pending');
    expect(body.application.memberName).toBe('张三-17915');

    const apps = await readStore();
    expect(apps).toHaveLength(1);
    expect(apps[0].applicantSub).toBe('7:17915');
    expect(apps[0].departmentPath).toBe('教务处/数学组');
    expect(mocks.audit).toHaveBeenCalledWith('member.apply', expect.objectContaining({ target: '张三-17915' }));
  });

  it('已有 pending 再提交返回 409', async () => {
    await POST(await memberRequest('http://portal.test/api/portal/members', { body: validBody }));
    const second = await POST(
      await memberRequest('http://portal.test/api/portal/members', { body: validBody })
    );

    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ code: 'application_exists' });
    await expect(readStore()).resolves.toHaveLength(1);
  });

  it('失败后 60 秒内再次提交返回 429', async () => {
    await POST(await memberRequest('http://portal.test/api/portal/members', { body: validBody }));

    // 直接把状态改成 needs_email 并补上最近尝试时间，模拟腾讯云刚返回失败
    const { mutateStore } = await import('@/lib/members/store');
    await mutateStore((apps) => {
      apps[0].status = 'needs_email';
      apps[0].lastAttemptAt = new Date().toISOString();
    });

    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', { body: validBody })
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ code: 'too_many_attempts' });
  });

  it('开通失败后本人可以重新提交申请，回到 pending 并可改部门', async () => {
    await POST(await memberRequest('http://portal.test/api/portal/members', { body: validBody }));

    // 模拟一次开通失败（真实链路里由审核通过后的编排落盘）
    const { mutateStore } = await import('@/lib/members/store');
    await mutateStore((apps) => {
      apps[0].status = 'failed';
      apps[0].errorCode = 'FailedOperation.CreateAccount';
      apps[0].errorMessage = '开通失败，请联系管理员重试';
    });

    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', {
        body: { ...validBody, departmentPath: '教务处/教研组', remark: '换部门重提' },
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      application: { status: string; departmentPath: string; errorCode: string | null };
    };
    expect(body.application.status).toBe('pending');
    expect(body.application.departmentPath).toBe('教务处/教研组');
    expect(body.application.errorCode).toBeNull();

    const apps = await readStore();
    expect(apps).toHaveLength(1);
    expect(apps[0].status).toBe('pending');
    expect(apps[0].events.at(-1)).toMatchObject({ from: 'failed', to: 'pending', actor: 'user' });
  });

  it('邮箱或手机号非法返回 400，且不落盘', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', {
        body: { ...validBody, email: 'bad' },
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'invalid_contact' });
    await expect(readStore()).resolves.toHaveLength(0);
  });

  it('部门路径非法返回 400 invalid_department，且不落盘', async () => {
    for (const departmentPath of ['', '   ', 'a/b/c/d', 'a//b', '教务处:东区']) {
      const response = await POST(
        await memberRequest('http://portal.test/api/portal/members', {
          body: { ...validBody, departmentPath },
        })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ code: 'invalid_department' });
    }

    await expect(readStore()).resolves.toHaveLength(0);
  });

  it('部门路径被归一化后落库（全角斜杠、首尾空白）', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', {
        body: { ...validBody, departmentPath: ' 教务处 ／ 数学组 ' },
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { application: { departmentPath: string } };
    expect(body.application.departmentPath).toBe('教务处/数学组');
  });

  it('请求体仍带 nodeId 时忽略该字段', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', {
        body: { ...validBody, nodeId: 2 },
      })
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { application: Record<string, unknown> };
    expect(body.application).not.toHaveProperty('nodeId');
  });

  it('PUBLIC_BASE_URL 未配置时返回 503', async () => {
    resetMembersEnv({ PORTAL_DATA_DIR: dataDir, PUBLIC_BASE_URL: '' });

    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', { body: validBody })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_configured' });
  });

  it('腾讯云凭据未配置（真实 provider）时返回 503', async () => {
    resetMembersEnv({ PORTAL_DATA_DIR: dataDir, MEMBER_ACCOUNT_PROVIDER: 'tencent' });

    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', { body: validBody })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_configured' });
  });

  it('未登录返回 401', async () => {
    const response = await POST(
      new Request('http://portal.test/api/portal/members', {
        method: 'POST',
        headers: { host: 'portal.test' },
      })
    );
    expect(response.status).toBe(401);
  });

  it('跨站 Origin 返回 403', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', {
        body: validBody,
        origin: 'https://evil.example.com',
      })
    );
    expect(response.status).toBe(403);
  });

  it('GET 自己提交时返回 405', async () => {
    const response = await POST(
      await memberRequest('http://portal.test/api/portal/members', { method: 'GET' })
    );
    expect(response.status).toBe(405);
  });
});

describe('GET /api/portal/members', () => {  it('没有申请单时返回 null', async () => {
    const response = await GET(
      await memberRequest('http://portal.test/api/portal/members', { method: 'GET' })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ application: null });
  });

  it('返回自己的申请单，不泄露他人的', async () => {
    await POST(await memberRequest('http://portal.test/api/portal/members', { body: validBody }));

    const response = await GET(
      await memberRequest('http://portal.test/api/portal/members', { method: 'GET' })
    );
    const body = (await response.json()) as { application: { applicantSub: string } | null };
    expect(body.application?.applicantSub).toBe('7:17915');

    const other = await GET(
      await memberRequest('http://portal.test/api/portal/members', {
        method: 'GET',
        sub: '7:99999',
      })
    );
    const otherBody = (await other.json()) as { application: unknown };
    expect(otherBody.application).toBeNull();
  });
});

describe('部门列表接口下线', () => {
  it('路由与节点缓存模块已删除，申请页不再引用组织架构', () => {
    const root = process.cwd();
    expect(existsSync(path.join(root, 'src/app/api/portal/members/nodes/route.ts'))).toBe(false);
    expect(existsSync(path.join(root, 'src/lib/members/nodes.ts'))).toBe(false);

    const page = readFileSync(path.join(root, 'src/app/(portal)/members/page.tsx'), 'utf8');
    expect(page).not.toContain('getOrganizationNodes');
  });
});
