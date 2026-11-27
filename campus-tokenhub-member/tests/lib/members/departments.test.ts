import { describe, expect, it, vi } from 'vitest';
import { DepartmentError, resolveDepartment } from '@/lib/members/departments';
import type { OrganizationNode } from '@/lib/members/types';
import { TencentApiError, createOrganizationClient, type OrganizationClient } from '@/lib/tencent/organization';
import { createMockOrganizationClient } from '@/lib/tencent/mock-client';

function node(nodeId: number, name: string, parentId: number): OrganizationNode {
  return { nodeId, name, parentId, path: name };
}

/** 最小可用的组织客户端：真实客户端的假替身，不模拟分页细节 */
function makeClient(nodes: OrganizationNode[], overrides: Partial<OrganizationClient> = {}) {
  const state = [...nodes];
  let nextId = 9000;

  const client: OrganizationClient = {
    kind: 'mock',
    describeNodes: vi.fn(async () => ({
      nodes: state.map((item) => ({ ...item })),
      truncated: false,
    })),
    addNode: vi.fn(async (input) => {
      if (state.some((item) => item.parentId === input.parentNodeId && item.name === input.name)) {
        throw new TencentApiError('FailedOperation.OrganizationNodeNameUsed', 'name used');
      }
      const created = node(nextId++, input.name, input.parentNodeId);
      state.push(created);
      return { nodeId: created.nodeId, requestId: 'req-add' };
    }),
    createMember: vi.fn(),
    bindEmail: vi.fn(),
    getEmailBindStatus: vi.fn(),
    findMemberByName: vi.fn(),
    deleteMember: async () => ({ requestId: 'mock-req', alreadyGone: false, pendingReview: false }),
    ...overrides,
  };

  return { client, state };
}

const ROOT = node(1000, 'Root', 0);

describe('mock 组织客户端', () => {
  it('mock 客户端 describeNodes 返回未截断标记', async () => {
    const client = createMockOrganizationClient();
    await expect(client.describeNodes()).resolves.toMatchObject({ truncated: false });
  });

  it('addNode 写入节点树并可被 describeNodes 读到', async () => {
    const client = createMockOrganizationClient();
    const before = (await client.describeNodes()).nodes;

    const created = await client.addNode({ parentNodeId: before[0].nodeId, name: '新建组' });
    expect(created.nodeId).toBeGreaterThan(0);

    const after = (await client.describeNodes()).nodes;
    expect(after.map((item) => item.name)).toContain('新建组');
    expect(after.find((item) => item.name === '新建组')?.parentId).toBe(before[0].nodeId);
  });

  it('同级重名抛 OrganizationNodeNameUsed，不同父节点允许同名', async () => {
    const client = createMockOrganizationClient();
    const nodes = (await client.describeNodes()).nodes;
    const root = nodes.find((item) => item.parentId === 0);
    const other = nodes.find((item) => item.parentId === root?.nodeId);

    await client.addNode({ parentNodeId: other!.nodeId, name: '语文组' });
    await expect(
      client.addNode({ parentNodeId: other!.nodeId, name: '语文组' })
    ).rejects.toMatchObject({ code: 'FailedOperation.OrganizationNodeNameUsed' });

    // 另一个父节点下同名允许
    await expect(client.addNode({ parentNodeId: root!.nodeId, name: '语文组' })).resolves.toMatchObject({
      nodeId: expect.any(Number),
    });
  });

  it('两个客户端实例的节点树互不影响', async () => {
    const a = createMockOrganizationClient();
    const b = createMockOrganizationClient();
    const nodesA = (await a.describeNodes()).nodes;
    const rootA = nodesA.find((item) => item.parentId === 0)!;

    await a.addNode({ parentNodeId: rootA.nodeId, name: 'A 学校专用组' });

    const nodesB = (await b.describeNodes()).nodes;
    expect(nodesB.map((item) => item.name)).not.toContain('A 学校专用组');
  });
});

describe('resolveDepartment', () => {
  it('路径全部存在时直接复用，不建节点', async () => {
    const { client } = makeClient([
      ROOT,
      node(1001, '教务处', 1000),
      node(1002, '数学组', 1001),
    ]);

    const result = await resolveDepartment({ segments: ['教务处', '数学组'], client });

    expect(result).toMatchObject({ nodeId: 1002, path: '教务处/数学组', created: [] });
    expect(result.rootNodeId).toBe(1000);
    expect(client.addNode).not.toHaveBeenCalled();
    expect(client.describeNodes).toHaveBeenCalledWith({
      maxPages: 4,
      deadline: expect.any(Number),
    });
  });

  it('只创建缺失层级，父节点链正确', async () => {
    const { client } = makeClient([ROOT, node(1001, '教务处', 1000)]);

    const result = await resolveDepartment({ segments: ['教务处', '数学组'], client });

    expect(result.created).toEqual(['数学组']);
    expect(result.path).toBe('教务处/数学组');
    expect(client.addNode).toHaveBeenCalledTimes(1);
    expect(client.addNode).toHaveBeenCalledWith({
      parentNodeId: 1001,
      name: '数学组',
      remark: 'portal:auto',
    });
  });

  it('全部缺失时从根节点逐级创建', async () => {
    const { client } = makeClient([ROOT]);

    const result = await resolveDepartment({ segments: ['教务处', '数学组'], client });

    expect(result.created).toEqual(['教务处', '数学组']);
    const calls = (client.addNode as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0][0]).toMatchObject({ parentNodeId: 1000, name: '教务处' });
    expect(calls[1][0]).toMatchObject({ parentNodeId: 9000, name: '数学组' });
  });

  it('首段与根节点同名时被忽略（忽略大小写）', async () => {
    const { client } = makeClient([ROOT, node(1001, '教务处', 1000)]);

    const result = await resolveDepartment({ segments: ['root', '教务处'], client });

    expect(result.nodeId).toBe(1001);
    expect(result.path).toBe('教务处');
  });

  it('只填根节点名时返回 department_empty', async () => {
    const { client } = makeClient([ROOT]);

    await expect(resolveDepartment({ segments: ['Root'], client })).rejects.toMatchObject({
      code: 'department_empty',
    });
  });

  it('树中没有根节点时报 department_root_missing', async () => {
    const { client } = makeClient([node(1001, '教务处', 1002)]);

    await expect(resolveDepartment({ segments: ['教务处'], client })).rejects.toMatchObject({
      code: 'department_root_missing',
    });
    expect(client.addNode).not.toHaveBeenCalled();
  });

  it('多个根节点时取 nodeId 最小者并标记 multipleRoots', async () => {
    const { client } = makeClient([
      node(2000, 'Root-B', 0),
      node(1000, 'Root-A', 0),
      node(1001, '教务处', 1000),
    ]);

    const result = await resolveDepartment({ segments: ['教务处'], client });

    expect(result.rootNodeId).toBe(1000);
    expect(result.multipleRoots).toBe(true);
    expect(result.nodeId).toBe(1001);
  });

  it('配置的 rootNodeId 优先，且不存在时报 department_root_missing', async () => {
    const { client } = makeClient([ROOT, node(1001, '教务处', 1000), node(2000, 'Other', 0)]);

    const result = await resolveDepartment({ segments: ['教务处'], client, rootNodeId: 1000 });
    expect(result.rootNodeId).toBe(1000);

    await expect(
      resolveDepartment({ segments: ['教务处'], client: makeClient([ROOT]).client, rootNodeId: 123 })
    ).rejects.toMatchObject({ code: 'department_root_missing' });
  });

  it('重名时回查一次，命中即继续', async () => {
    const { client, state } = makeClient([ROOT]);
    let first = true;
    const addNode = vi.fn(async (input: { parentNodeId: number; name: string; remark?: string }) => {
      if (first) {
        first = false;
        // 模拟并发：对方已经建好，本地树还没看到
        state.push(node(7777, input.name, input.parentNodeId));
        throw new TencentApiError('FailedOperation.OrganizationNodeNameUsed', 'used');
      }
      throw new TencentApiError('unexpected', 'unexpected');
    });
    const racing: OrganizationClient = { ...client, addNode };

    const result = await resolveDepartment({ segments: ['教务处'], client: racing });

    expect(result.nodeId).toBe(7777);
    expect(result.created).toEqual([]);
  });

  it('重名且回查仍不命中时报 department_conflict', async () => {
    const { client } = makeClient([ROOT]);
    const addNode = vi.fn(async () => {
      throw new TencentApiError('FailedOperation.OrganizationNodeNameUsed', 'used');
    });

    await expect(
      resolveDepartment({ segments: ['教务处'], client: { ...client, addNode } })
    ).rejects.toMatchObject({ code: 'department_conflict' });
  });

  it('组织节点超过 4 页时报 department_tree_too_large', async () => {
    const many = Array.from({ length: 201 }, (_, index) =>
      node(2000 + index, `部门${index}`, index === 0 ? 0 : 2000)
    );
    const { client } = makeClient(many);

    await expect(resolveDepartment({ segments: ['部门1'], client })).rejects.toMatchObject({
      code: 'department_tree_too_large',
    });
  });

  it('真实客户端在达到页数上限且仍有节点时报 department_tree_too_large', async () => {
    const total = 201;
    const pages = Array.from({ length: 5 }, (_, page) => ({
      Response: {
        Total: total,
        Items: Array.from({ length: 50 }, (_, index) => ({
          NodeId: 1000 + page * 50 + index,
          Name: index === 0 && page === 0 ? 'Root' : `部门${page}-${index}`,
          ParentNodeId: index === 0 && page === 0 ? 0 : 1000,
        })),
        RequestId: `p${page}`,
      },
    }));

    let cursor = 0;
    const fakeFetch = (async () =>
      new Response(JSON.stringify(pages[Math.min(cursor++, pages.length - 1)]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;

    const client = createOrganizationClient(
      {
        secretId: 'AKIDtest',
        secretKey: 'secret',
        region: 'ap-guangzhou',
        endpoint: 'organization.tencentcloudapi.com',
      },
      { fetchImpl: fakeFetch, now: () => 0 }
    );

    await expect(resolveDepartment({ segments: ['部门0-0'], client })).rejects.toMatchObject({
      code: 'department_tree_too_large',
    });
  });

  it('空分段直接拒绝，不发起腾讯云调用', async () => {
    const { client } = makeClient([ROOT]);

    await expect(resolveDepartment({ segments: [], client })).rejects.toMatchObject({
      code: 'department_empty',
    });
    await expect(resolveDepartment({ segments: ['教务处', ' '], client })).rejects.toMatchObject({
      code: 'department_failed',
    });
    expect(client.describeNodes).not.toHaveBeenCalled();
  });

  it('创建节点未返回有效 ID 时失败，不继续下探', async () => {
    const { client } = makeClient([ROOT]);
    const addNode = vi.fn(async () => ({ nodeId: 0, requestId: 'r' }));

    await expect(
      resolveDepartment({ segments: ['教务处'], client: { ...client, addNode } })
    ).rejects.toMatchObject({ code: 'department_failed' });
    expect(addNode).toHaveBeenCalledTimes(1);
  });

  it('逐级创建过程中预算用尽即停', async () => {
    const { client } = makeClient([ROOT]);
    let clock = 0;
    const current = () => clock;
    const describeNodes = vi.fn(async () => {
      clock += 3_000;
      return { nodes: [{ ...ROOT }], truncated: false };
    });
    const addNode = vi.fn(async () => {
      clock += 3_000;
      return { nodeId: 9000, requestId: 'r' };
    });

    await expect(
      resolveDepartment({
        segments: ['教务处'],
        client: { ...client, describeNodes, addNode },
        budgetMs: 5_000,
        now: current,
      })
    ).rejects.toMatchObject({ code: 'department_timeout' });

    // 预算在「建节点之后」被检查到：节点已建，但不会继续下探也不再建号
    expect(addNode).toHaveBeenCalledTimes(1);
  });

  it('腾讯云非重名错误原样抛出，由编排层翻译', async () => {
    const { client } = makeClient([ROOT]);
    const addNode = vi.fn(async () => {
      throw new TencentApiError('UnauthorizedOperation', 'no permission', 'req-x');
    });

    const error = await resolveDepartment({
      segments: ['教务处'],
      client: { ...client, addNode },
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(DepartmentError);
    expect((error as DepartmentError).code).toBe('UnauthorizedOperation');
    expect((error as DepartmentError).requestId).toBe('req-x');
  });
});
