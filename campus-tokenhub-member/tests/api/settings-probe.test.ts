import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POST } from '@/app/api/portal/settings/probe/route';
import { resetProbeRateLimit } from '@/lib/config/probe-rate-limit';
import { resetConfigCache } from '@/lib/config';
import { resetOverlayForTests } from '@/lib/config/overlay';
import { resetConfigStoreCache, setConfigRepoOverride } from '@/lib/config/store';
import { setProbeClientFactory } from '@/lib/config/probe';
import { TencentApiError, type OrganizationClient } from '@/lib/tencent/organization';
import { resetOrganizationClientCache } from '@/lib/tencent/factory';
import { signSession } from '@/lib/auth/session';
import { membersBaseEnv, stubAdminRoster } from '../helpers/members';
import { memoryConfigRepo } from '../helpers/config';

const ADMIN_EMAIL = 'admin@school.edu.cn';
/** 管理员身份（写进名单桩的那个 sub）与用例里的非管理员身份 */
const ADMIN_SUB = '7:17915';
const TEACHER_SUB = '7:99001';
const original = { ...process.env };

function fakeTencentClient(
  nodes: { nodeId: number; name: string; parentId: number; path: string }[],
  calls: string[] = []
): OrganizationClient {
  return {
    kind: 'tencent',
    async describeNodes() {
      calls.push('describeNodes');
      return { nodes, truncated: false };
    },
    async addNode() {
      calls.push('addNode');
      throw new Error('探测不应写组织节点');
    },
    async createMember() {
      calls.push('createMember');
      throw new Error('探测不应创建成员');
    },
    async bindEmail() {
      calls.push('bindEmail');
      throw new Error('探测不应绑定邮箱');
    },
    async describeMemberEmails() {
      calls.push('describeMemberEmails');
      return [];
    },
    async describeMembers() {
      calls.push('describeMembers');
      return [];
    },
  } as unknown as OrganizationClient;
}

async function request(
  body: unknown,
  options: { email?: string | null; sub?: string; origin?: string } = {}
): Promise<Request> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    origin: options.origin ?? 'http://portal.test',
    host: 'portal.test',
  };
  if (options.email !== null) {
    const token = await signSession({
      sub: options.sub ?? ADMIN_SUB,
      email: options.email ?? ADMIN_EMAIL,
      name: '管理员',
    });
    headers.cookie = `portal_session=${token}`;
  }
  return new Request('http://portal.test/api/portal/settings/probe', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env = {
    ...original,
    ...membersBaseEnv,
    TENCENTCLOUD_SECRET_ID: '',
    TENCENTCLOUD_SECRET_KEY: '',
  };
  resetConfigCache();
  resetOverlayForTests();
  resetConfigStoreCache();
  // 管理员只认共享名单（ADMIN_EMAILS 已移除）：管理员身份靠名单桩授予
  stubAdminRoster([ADMIN_SUB]);
  // 探测会把结论写进分组验证状态：用内存仓库，避免测试碰真实数据库
  setConfigRepoOverride(memoryConfigRepo().repo);
  resetOrganizationClientCache();
  resetProbeRateLimit();
});

afterEach(() => {
  process.env = { ...original };
  resetConfigCache();
  resetOverlayForTests();
  setProbeClientFactory(null);
});

describe('POST /api/portal/settings/probe（腾讯云）', () => {
  it('未配置凭据返回 400 与 not_configured', async () => {
    const response = await POST(await request({ group: 'tencent', draft: {} }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('not_configured');
  });

  it('凭据鉴权失败映射为 invalid_credential，不透出原始英文错误', async () => {
    setProbeClientFactory(() => fakeTencentClient([]));
    setProbeClientFactory(() => {
      throw new TencentApiError('AuthFailure.SignatureFailure', 'The signature is expired');
    });

    const response = await POST(
      await request({ group: 'tencent', draft: { secretId: 'AKIDx', secretKey: 'k' } })
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.code).toBe('invalid_credential');
    expect(JSON.stringify(body)).not.toContain('signature is expired');
  });

  it('缺少 organization 权限映射为 no_permission', async () => {
    setProbeClientFactory(() => {
      throw new TencentApiError('UnauthorizedOperation', 'no permission');
    });

    const response = await POST(
      await request({ group: 'tencent', draft: { secretId: 'AKIDx', secretKey: 'k' } })
    );
    expect((await response.json()).code).toBe('no_permission');
  });

  it('成功时返回根节点、节点数与多根标记', async () => {
    const calls: string[] = [];
    setProbeClientFactory(() =>
      fakeTencentClient(
        [
          { nodeId: 1000, name: '某某大学', parentId: 0, path: '某某大学' },
          { nodeId: 1001, name: '教务处', parentId: 1000, path: '某某大学 / 教务处' },
        ],
        calls
      )
    );

    const response = await POST(
      await request({ group: 'tencent', draft: { secretId: 'AKIDx', secretKey: 'k' } })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.detail.root).toEqual({ nodeId: 1000, name: '某某大学' });
    expect(body.detail.nodeCount).toBe(2);
    expect(body.detail.multipleRoots).toBe(false);
    // 探测只读：不允许任何写操作
    expect(calls).toEqual(['describeNodes']);
  });

  it('响应体不含草稿里的密钥明文', async () => {
    setProbeClientFactory(() => fakeTencentClient([{ nodeId: 1, name: 'root', parentId: 0, path: 'root' }]));

    const response = await POST(
      await request({
        group: 'tencent',
        draft: { secretId: 'AKIDplainSecretId', secretKey: 'plainSecretKey' },
      })
    );
    const raw = await response.text();
    expect(raw).not.toContain('AKIDplainSecretId');
    expect(raw).not.toContain('plainSecretKey');
  });

  it('测已保存的配置时把结论记进分组验证状态', async () => {
    process.env.TENCENTCLOUD_SECRET_ID = 'AKIDsaved';
    process.env.TENCENTCLOUD_SECRET_KEY = 'savedKey';
    resetConfigCache();
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    setProbeClientFactory(() =>
      fakeTencentClient([{ nodeId: 1, name: 'root', parentId: 0, path: 'root' }])
    );

    const response = await POST(await request({ group: 'tencent', draft: {} }));

    expect(response.status).toBe(200);
    expect(state.verify.tencent.status).toBe('ok');
  });

  it('带草稿探测不改写已保存配置的验证状态', async () => {
    const { repo, state } = memoryConfigRepo();
    setConfigRepoOverride(repo);
    setProbeClientFactory(() => {
      throw new TencentApiError('AuthFailure.SignatureFailure', 'bad signature');
    });

    const response = await POST(
      await request({ group: 'tencent', draft: { secretId: 'AKIDx', secretKey: 'k' } })
    );

    expect(response.status).toBe(400);
    expect(state.calls.verify).toBe(0);
    expect(state.verify.tencent.status).toBe('unverified');
  });

  it('不支持的探测分组返回 400', async () => {
    const response = await POST(await request({ group: 'unknown' }));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('unsupported_group');
  });

  it('非管理员返回 403', async () => {
    const response = await POST(
      await request({ group: 'tencent' }, { email: 'teacher@school.edu.cn', sub: TEACHER_SUB })
    );
    expect(response.status).toBe(403);
  });
});
