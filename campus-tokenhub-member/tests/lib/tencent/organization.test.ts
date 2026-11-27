import { describe, expect, it } from 'vitest';
import {
  TencentApiError,
  createOrganizationClient,
  type OrganizationClientConfig,
} from '@/lib/tencent/organization';

const config: OrganizationClientConfig = {
  secretId: 'AKIDtest',
  secretKey: 'secret-key',
  region: 'ap-guangzhou',
  endpoint: 'organization.tencentcloudapi.com',
  timeoutMs: 50,
};

type Call = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fakeFetch(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('组织接口客户端', () => {
  it('请求头带 Action / Version / 签名，body 为对应参数', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ Response: { Total: 0, Items: [], RequestId: 'req-1' } })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 1794986400000 });
    await client.describeNodes();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('DescribeOrganizationNodes');
    expect(headers['X-TC-Version']).toBe('2021-03-31');
    expect(headers['X-TC-Region']).toBe('ap-guangzhou');
    expect(headers['Authorization']).toMatch(/^TC3-HMAC-SHA256 /);
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toMatchObject({ Limit: 50, Offset: 0 });
  });

  it('Response.Error 抛 TencentApiError，带 code / requestId', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({
        Response: {
          Error: {
            Code: 'FailedOperation.EmailAlreadyUsed',
            Message: 'email used',
            RequestId: 'req-err',
          },
        },
      })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });

    await expect(
      client.bindEmail({ uin: '100', email: 'a@b.com', countryCode: '86', phone: '13800000000' })
    ).rejects.toMatchObject({
      code: 'FailedOperation.EmailAlreadyUsed',
      requestId: 'req-err',
    });
  });

  it('部门分页合并，Total 到顶即停', async () => {
    const pages = [
      {
        Response: {
          Total: 3,
          Items: [
            { NodeId: 1, Name: '总部', ParentNodeId: 0 },
            { NodeId: 2, Name: '教务处', ParentNodeId: 1 },
          ],
          RequestId: 'p1',
        },
      },
      {
        Response: {
          Total: 3,
          Items: [{ NodeId: 3, Name: '数学组', ParentNodeId: 2 }],
          RequestId: 'p2',
        },
      },
    ];

    let index = 0;
    const { impl, calls } = fakeFetch(() => jsonResponse(pages[index++]));

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    const { nodes, truncated } = await client.describeNodes();

    expect(truncated).toBe(false);
    expect(nodes.map((node) => node.nodeId)).toEqual([1, 2, 3]);
    expect(nodes.find((node) => node.nodeId === 3)?.path).toBe('总部 / 教务处 / 数学组');
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[1].init.body))).toMatchObject({ Offset: 50 });
  });

  it('缺凭据时抛 not_configured，且不发请求', async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse({ Response: { Items: [] } }));
    const client = createOrganizationClient(
      { ...config, secretId: '', secretKey: '' },
      { fetchImpl: impl, now: () => 0 }
    );

    await expect(client.describeNodes()).rejects.toMatchObject({ code: 'not_configured' });
    expect(calls).toHaveLength(0);
  });

  it('网络异常包装成 NetworkError', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    const error = await client.describeNodes().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TencentApiError);
    expect((error as TencentApiError).code).toBe('NetworkError');
  });

  it('超过超时预算时抛 Timeout', async () => {
    const impl = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    const client = createOrganizationClient(
      { ...config, timeoutMs: 10 },
      { fetchImpl: impl, now: () => 0 }
    );

    await expect(client.describeNodes()).rejects.toMatchObject({ code: 'Timeout' });
  });

  it('按名回查找不到时返回 null', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({ Response: { Total: 0, Items: [], RequestId: 'r' } })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    await expect(client.findMemberByName('张三-17915')).resolves.toBeNull();
  });

  it('按名回查命中时返回 uin 与 Remark', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({
        Response: {
          Total: 1,
          Items: [{ Name: '张三-17915', MemberUin: 123456, Remark: 'portal:7:17915' }],
          RequestId: 'r',
        },
      })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    await expect(client.findMemberByName('张三-17915')).resolves.toEqual({
      uin: '123456',
      name: '张三-17915',
      remark: 'portal:7:17915',
    });
  });

  it('绑定状态查询把 BindStatus 透传出来', async () => {
    const { impl } = fakeFetch(() =>
      jsonResponse({ Response: { BindStatus: 'Success', RequestId: 'r' } })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    await expect(client.getEmailBindStatus('123456')).resolves.toMatchObject({
      bindStatus: 'Success',
    });
  });

  it('addNode 提交 ParentNodeId / Name / Remark，并返回 NodeId', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({ Response: { NodeId: 1001, RequestId: 'req-add' } })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    const result = await client.addNode({ parentNodeId: 101, name: '数学组', remark: 'portal:auto' });

    expect(result).toEqual({ nodeId: 1001, requestId: 'req-add' });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-TC-Action']).toBe('AddOrganizationNode');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      ParentNodeId: 101,
      Name: '数学组',
      Remark: 'portal:auto',
    });
  });

  it('describeNodes 支持限制分页数，超出即停', async () => {
    const { impl, calls } = fakeFetch(() =>
      jsonResponse({
        Response: {
          Total: 1000,
          Items: [{ NodeId: 1, Name: 'Root', ParentNodeId: 0 }],
          RequestId: 'r',
        },
      })
    );

    const client = createOrganizationClient(config, { fetchImpl: impl, now: () => 0 });
    const result = await client.describeNodes({ maxPages: 2 });

    expect(calls).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });
});
