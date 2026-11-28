import { beforeEach, describe, expect, it } from 'vitest';
import { resetConfigCache } from '@/lib/config';
import { getOrganizationClient, resetOrganizationClientCache } from '@/lib/tencent/factory';

const baseEnv = {
  OCTAFUSE_ADMIN_BASE: 'http://gateway.test:8789',
  OCTAFUSE_PROXY_BASE: 'http://gateway.test:8790',
  // 成员站不依赖网关：不注入任何 OCTAFUSE_* 凭据（loadConfig 不读取）
  OCTAFUSE_EXTERNAL_SYSTEM: 'campus-tokenhub',
  SESSION_SECRET: 'K7q2mZ9rT4wX8bN3vF6hJ1sL5pY0cA2d',
};

beforeEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('MEMBER_') || key.startsWith('TENCENTCLOUD_') || key === 'NODE_ENV') {
      delete process.env[key];
    }
  }
  Object.assign(process.env, baseEnv);
  resetConfigCache();
  resetOrganizationClientCache();
});

describe('getOrganizationClient', () => {
  it('默认返回真实客户端', () => {
    expect(getOrganizationClient().kind).toBe('tencent');
  });

  it('MEMBER_ACCOUNT_PROVIDER=mock 返回假客户端，且五个方法可用', async () => {
    process.env.MEMBER_ACCOUNT_PROVIDER = 'mock';
    resetConfigCache();

    const client = getOrganizationClient();
    expect(client.kind).toBe('mock');

    const { nodes } = await client.describeNodes();
    expect(nodes.length).toBeGreaterThan(0);

    const created = await client.createMember({
      name: '张三-17915',
      accountName: '张三-17915',
      nodeId: 2,
      policyType: 'Financial',
      permissionIds: [1, 2],
      remark: 'portal:7:17915',
    });
    expect(created.uin).toBeTruthy();

    await expect(
      client.bindEmail({
        uin: created.uin,
        email: 'zhangsan@school.edu',
        countryCode: '86',
        phone: '13800000000',
      })
    ).resolves.toMatchObject({ bindId: expect.any(String) });

    await expect(client.getEmailBindStatus(created.uin)).resolves.toMatchObject({
      bindStatus: 'Success',
    });
    await expect(client.findMemberByName('张三-17915')).resolves.toMatchObject({
      uin: created.uin,
      remark: 'portal:7:17915',
    });
  });

  it('mock 客户端对重名建号抛 OrganizationMemberNameUsed', async () => {
    process.env.MEMBER_ACCOUNT_PROVIDER = 'mock';
    resetConfigCache();
    const client = getOrganizationClient();

    const input = {
      name: '李四-1',
      accountName: '李四-1',
      nodeId: 1,
      policyType: 'Financial',
      permissionIds: [1, 2],
      remark: 'portal:7:1',
    };
    await client.createMember(input);
    await expect(client.createMember(input)).rejects.toMatchObject({
      code: 'FailedOperation.OrganizationMemberNameUsed',
    });
  });

  it('生产环境不允许 mock 客户端', () => {
    Object.assign(process.env, {
      MEMBER_ACCOUNT_PROVIDER: 'mock',
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'oauth2',
    });
    resetConfigCache();

    expect(() => getOrganizationClient()).toThrow('MEMBER_ACCOUNT_PROVIDER=mock');
  });
});
